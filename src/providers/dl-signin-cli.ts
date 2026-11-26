/**
 * The free tier's sign-in in a terminal: `autopilot auth directionally-local`,
 * and `autopilot acp --login` (the sign-in an ACP client such as Zed opens in
 * a terminal). GitHub's device code in the browser, then the free tier
 * becomes the active provider. Returns the exit code.
 */

import { loadConfig } from "../config.js";

export async function runDlSignIn(opts: { referral?: string }): Promise<number> {
  const dl = await import("./directionally-local.js");
  const { switchProvider } = await import("./keys.js");
  const { openBrowser } = await import("../ui/app-helpers.js");
  try {
    console.log(`Free: DeepSeek V4.1 Flash, ${dl.formatTokens(dl.DL_FREE_WEEKLY_TOKENS)} tokens a week, no card.`);
    console.log(dl.DL_DISCLOSURE);
    await dl.dlSignIn(
      (code) => {
        const opened = openBrowser(code.verificationUriComplete);
        console.log(`\nYour code: ${code.userCode}`);
        console.log(`${opened ? "Opened" : "Open"} ${code.verificationUriComplete} — sign in with GitHub and approve it (enter an invite code there if asked).`);
        console.log("Waiting for you to approve…");
      },
      { where: "cli", ...(opts.referral ? { referralCode: opts.referral } : {}) },
    );
    await switchProvider(await loadConfig().catch(() => null), "directionally-local");
    const me = await dl.fetchDlMe().catch(() => null);
    console.log(dl.dlSignedInLine(me));
    const invite = dl.dlSignedInInviteLine(me, "cli");
    if (invite) console.log(invite);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
