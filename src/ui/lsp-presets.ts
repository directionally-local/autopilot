// Language servers the LSP setup wizard offers out of the box.

export interface Preset {
  id: string;
  name: string;
  description: string;
  command: string[];
  installCommand: string;
  installHint: string;
}

export const PRESETS: Preset[] = [
  {
    id: "typescript",
    name: "TypeScript",
    description: "TypeScript and JavaScript support",
    command: ["typescript-language-server", "--stdio"],
    installCommand: "npm install -g typescript-language-server typescript",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "python",
    name: "Python (Pyright)",
    description: "Python type checking and IntelliSense",
    command: ["pyright-langserver", "--stdio"],
    installCommand: "npm install -g pyright",
    installHint: "Requires Node.js and npm (alternative: pip install pyright)",
  },
  {
    id: "rust",
    name: "Rust",
    description: "Rust analyzer for Rust code",
    command: ["rust-analyzer"],
    installCommand: "rustup component add rust-analyzer",
    installHint: "Requires Rust toolchain (rustup)",
  },
  {
    id: "go",
    name: "Go",
    description: "Go language server (gopls)",
    command: ["gopls"],
    installCommand: "go install golang.org/x/tools/gopls@latest",
    installHint: "Requires Go toolchain",
  },
  {
    id: "json",
    name: "JSON",
    description: "JSON language support",
    command: ["vscode-json-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "css",
    name: "CSS",
    description: "CSS/SCSS/Less language support",
    command: ["vscode-css-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "html",
    name: "HTML",
    description: "HTML language support",
    command: ["vscode-html-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "eslint",
    name: "ESLint",
    description: "JavaScript/TypeScript linting",
    command: ["vscode-eslint-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "docker",
    name: "Dockerfile",
    description: "Dockerfile language support",
    command: ["docker-langserver", "--stdio"],
    installCommand: "npm install -g dockerfile-language-server-nodejs",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "yaml",
    name: "YAML",
    description: "YAML language support",
    command: ["yaml-language-server", "--stdio"],
    installCommand: "npm install -g yaml-language-server",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "bash",
    name: "Bash",
    description: "Bash shell script support",
    command: ["bash-language-server", "start"],
    installCommand: "npm install -g bash-language-server",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "lua",
    name: "Lua",
    description: "Lua language support",
    command: ["lua-language-server"],
    installCommand: "brew install lua-language-server  (macOS) or see https://luals.github.io",
    installHint: "Install varies by platform — see https://luals.github.io",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Enter your own language server command",
    command: [],
    installCommand: "",
    installHint: "You will enter the command manually",
  },
];
