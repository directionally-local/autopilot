# Running Autopilot on a Linux server (Hetzner)

This guide sets up `autopilot serve` as a long-lived service for [unattended runs](long-running-unattended-runs.md) on one Linux host, such as a Hetzner dedicated or cloud server running Ubuntu 24.04. It covers a dedicated user, systemd, access over SSH, limits and the kill switch, upgrades, and encrypted off-host backups with a restore test.

## 1. Host and user

```sh
# Node.js 20+ and the tools runs typically need
sudo apt-get update && sudo apt-get install -y git sqlite3 restic curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# A dedicated, non-root account; repositories for runs live under /srv/autopilot
sudo useradd --create-home --shell /bin/bash autopilot
sudo mkdir -p /srv/autopilot && sudo chown autopilot:autopilot /srv/autopilot

sudo npm install -g autopilot-ai
```

Clone the repositories that runs will work on into `/srv/autopilot` as the `autopilot` user. Give that user only the credentials runs need, for example a deploy key or fine-grained token scoped to those repositories.

## 2. Secrets

Keep secrets in an environment file that only root can read. systemd loads it before dropping privileges.

```sh
sudo mkdir -p /etc/autopilot
sudo install -m 600 /dev/null /etc/autopilot/autopilot.env
sudoedit /etc/autopilot/autopilot.env
```

```sh
KIMIFLARE_SERVER_PASSWORD=<long random string>     # required for /runs
OPENROUTER_API_KEY=sk-or-...                        # or another provider's key
AUTOPILOT_MAX_CONCURRENT_RUNS=4                     # runs doing work at once
# Email when a run finishes, fails or needs input (optional)
RESEND_API_KEY=re_...
AUTOPILOT_NOTIFY_EMAIL_TO=you@example.com
AUTOPILOT_NOTIFY_EMAIL_FROM=Autopilot <bot@your-verified-domain.com>
```

## 3. Service

```sh
sudo cp deploy/autopilot.service /etc/systemd/system/autopilot.service   # from this repository
sudo systemctl daemon-reload
sudo systemctl enable --now autopilot
systemctl status autopilot
journalctl -u autopilot -f        # structured server logs
```

The unit runs as `autopilot`, listens on `127.0.0.1:4096` only, restarts on failure, and is hardened. The filesystem is read-only except the user's home and `/srv/autopilot`. It uses `KillMode=process`, so managed jobs (training runs, long builds) keep running in their own process groups across restarts. On restart, the server picks runs back up per the checkpoint rule: runs whose last tool call has an unknown outcome become `interrupted_unknown` instead of being replayed.

## 4. Access

Don't expose the server publicly. Tunnel to it:

```sh
ssh -L 4096:127.0.0.1:4096 autopilot@your-host
curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" http://127.0.0.1:4096/runs   # health check + run list
```

## 5. Limits and the kill switch

- **Concurrency:** at most `AUTOPILOT_MAX_CONCURRENT_RUNS` runs (default 4) can be queued or running at once. Creating or resuming one past the limit returns `429`. Waiting and paused runs don't count.
- **Per-run budgets:** runtime, tokens, cost and tool iterations, as described in [the runs guide](long-running-unattended-runs.md).
- **Kill switch:** cancel every active run and refuse new ones. Add `"jobs": true` to also cancel running managed jobs.

  ```sh
  curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" -H 'Content-Type: application/json' \
    -d '{"reason": "incident", "jobs": true}' -X POST http://127.0.0.1:4096/runs/stop-all
  ```

  The halt is stored in the runs database, so it survives restarts. Lift it with `curl -u … -X DELETE http://127.0.0.1:4096/runs/stop-all`. For a hard stop, run `sudo systemctl stop autopilot`; managed jobs keep running until you cancel them.

## 6. Upgrades

```sh
curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" http://127.0.0.1:4096/runs   # note what's active
sudo npm install -g autopilot-ai@latest
sudo systemctl restart autopilot
journalctl -u autopilot -n 50
```

Runs waiting on timers or jobs resume on their own after the restart. A run that was in the middle of a turn resumes from its last checkpoint, or becomes `interrupted_unknown` if its last tool call can't be confirmed.

## 7. Encrypted off-host backups

All state lives in the `autopilot` user's home:

| What | Path |
| --- | --- |
| Runs, events, timers, notifications | `~/.local/state/autopilot/runs.db` |
| Managed jobs | `~/.local/state/autopilot/jobs.db` (+ job logs next to it) |
| Sessions (conversation checkpoints) | `~/.local/share/kimiflare/sessions/` |
| Config | `~/.config/kimiflare/config.json` |

SQLite files must be copied with `.backup` (a consistent snapshot even while the server writes), not `cp`. A nightly encrypted backup to a Hetzner Storage Box with restic:

```sh
sudo -u autopilot -i
export RESTIC_REPOSITORY=sftp:u123456@u123456.your-storagebox.de:autopilot
export RESTIC_PASSWORD_FILE=~/.restic-password        # chmod 600; keep a copy off the host
restic init                                            # once

cat > ~/backup.sh <<'SH'
#!/bin/sh
set -eu
export RESTIC_REPOSITORY=sftp:u123456@u123456.your-storagebox.de:autopilot
export RESTIC_PASSWORD_FILE=$HOME/.restic-password
snap=$HOME/.local/state/autopilot/backup-snapshot
mkdir -p "$snap"
sqlite3 "$HOME/.local/state/autopilot/runs.db" ".backup '$snap/runs.db'"
sqlite3 "$HOME/.local/state/autopilot/jobs.db" ".backup '$snap/jobs.db'"
restic backup "$snap" "$HOME/.local/share/kimiflare/sessions" "$HOME/.config/kimiflare" --tag autopilot
restic forget --keep-daily 14 --keep-weekly 8 --prune
SH
chmod 700 ~/backup.sh
(crontab -l 2>/dev/null; echo "17 3 * * * $HOME/backup.sh >> $HOME/backup.log 2>&1") | crontab -
```

restic encrypts everything client-side. The Storage Box sees only ciphertext.

### Restore test (do this once, then periodically)

On a scratch machine or directory, not the live host:

```sh
export RESTIC_REPOSITORY=sftp:u123456@u123456.your-storagebox.de:autopilot RESTIC_PASSWORD_FILE=~/.restic-password
restic snapshots --tag autopilot
restic restore latest --target /tmp/autopilot-restore
sqlite3 /tmp/autopilot-restore/*/backup-snapshot/runs.db "PRAGMA integrity_check; SELECT status, COUNT(*) FROM runs GROUP BY status;"
ls /tmp/autopilot-restore/*/.local/share/kimiflare/sessions | head
```

To restore for real:
1. `systemctl stop autopilot`.
2. Put `runs.db` and `jobs.db` back under `~/.local/state/autopilot/`, and the sessions and config directories back in place.
3. `systemctl start autopilot`.

Runs that were mid-turn at backup time come back as `interrupted_unknown`, so nothing is replayed blindly.
