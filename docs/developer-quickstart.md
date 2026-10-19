# ILN Frontend Developer Quickstart

Welcome! This guide takes a new contributor from a fresh clone to a running local development environment for the Invoice Liquidity Network frontend.

**Verified against the current repository setup:** Next.js 16.2.4, React 19.2.4, Node 20.9.0, pnpm 9, Husky 9, Supabase-gated reminders, Resend-gated email delivery, and Freighter on Stellar Testnet.

## ⚡ Fastest Option: GitHub Codespaces / Dev Container

The repo ships a fully pre-configured **dev container** (`.devcontainer/devcontainer.json`) that gives you the exact same environment used in CI — Node 20.9.0, pnpm 9.0.0, and all recommended VS Code extensions — with zero local setup.

### Option A — GitHub Codespaces (cloud, browser or VS Code)

1. Click **Code → Codespaces → Create codespace on this branch** on the GitHub repo page.
2. Wait ~2 minutes for the container to build and `pnpm install` to run automatically.
3. Run the dev server:
   ```bash
   pnpm dev
   ```
4. Codespaces will forward port **3000** and prompt you to open it in your browser.

### Option B — VS Code Dev Container (local Docker)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
2. Open the cloned repository in VS Code.
3. When prompted, click **Reopen in Container** (or run `Dev Containers: Reopen in Container` from the Command Palette).
4. VS Code will build the image, run `pnpm install`, and forward ports automatically.

### Verify the devcontainer works

Once inside the container, run:

```bash
pnpm install   # should be instant — already run by postCreateCommand
pnpm dev       # should start Next.js on http://localhost:3000
```

Both commands must succeed without errors for the environment to be considered healthy.

---

## Prerequisites

### 1. Node.js 20.9.0

The repo pins Node in `.nvmrc` and `package.json` requires Node `>=20.9.0 <21`.

```bash
node --version   # should print v20.9.0
```

Recommended install with `nvm`:

```bash
nvm install 20.9.0
nvm use
```

### 2. pnpm 9

This project uses pnpm in CI and commits `pnpm-lock.yaml`.

```bash
corepack enable
corepack prepare pnpm@9.0.0 --activate
pnpm --version
```

### 3. Freighter Wallet

Install Freighter, create or import a wallet, and switch the wallet network to **Testnet** before trying to submit, fund, pay, or dispute invoices.

- Chrome/Brave: [Chrome Web Store](https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcffkeieiokmgtzutddc)
- Firefox: [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/freighter/)
- Wallet docs: [freighter.app](https://freighter.app)

### 4. Optional Stellar CLI

The app can run without Stellar CLI, but it is useful for advanced testnet checks.

```bash
brew install stellar-cli
```

## Fresh Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/Invoice-Liquidity-Network/ILN-Frontend.git
cd ILN-Frontend
```

### Step 2: Install Dependencies

```bash
pnpm install
```

The `prepare` script runs Husky during install. After a successful install, `.husky/pre-commit` runs lint-staged and `.husky/pre-push` runs `tsc --noEmit`.

### Step 3: Configure Environment Variables

```bash
cp .env.local.example .env.local
```

The checked-in example contains safe defaults for Stellar Testnet and placeholders for env-gated integrations. Local UI development works with the testnet defaults, but these integrations require real credentials:

| Integration                   | Variables                                                                                                                                                                          | Required when                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Supabase browser/client reads | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                                                                                                        | Testing notification/reminder persistence against Supabase                                                                          |
| Supabase server writes        | `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                                        | Running reminder cron behavior that bypasses RLS                                                                                    |
| Resend email delivery         | `RESEND_API_KEY`                                                                                                                                                                   | Sending payer reminder emails                                                                                                       |
| Protected reminder cron       | `CRON_SECRET`                                                                                                                                                                      | Calling `GET /api/reminders` outside local experiments                                                                              |
| GitHub feedback API           | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`                                                                                                                                      | Creating GitHub issues from feedback submissions                                                                                    |
| WalletConnect                 | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`                                                                                                                                             | Testing WalletConnect flows                                                                                                         |
| SEP-10 auth                   | `SEP10_SERVER_SECRET_KEY`, `SEP10_HOME_DOMAIN`, `JWT_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_NETWORK_PASSPHRASE`, `NEXT_PUBLIC_SUPABASE_URL` | Running SEP-10 challenge/verify; apply the [SEP-10 challenge migration](../supabase/migrations/002_sep10_auth_challenges.sql) first |

Use placeholder values only for routes you are not exercising. Never commit `.env.local`.

For local Supabase-backed reminder flows, create the tables described in [docs/supabase-setup.md](supabase-setup.md) and apply [supabase/migrations/001_init_reminders.sql](../supabase/migrations/001_init_reminders.sql).

### Step 4: Validate Env Example Sync

```bash
pnpm run env:check
```

This checks direct `process.env.*` references in `app/` and `src/` against `.env.local.example`. Runtime-provided keys live in `.env.local.example.allowlist`.

### Step 5: Start the Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Step 6: Fund a Freighter Testnet Account

1. Open Freighter and switch to **Testnet**.
2. Copy your public key.
3. Visit [Stellar Testnet Friendbot](https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY), replacing `YOUR_PUBLIC_KEY` with your account.
4. Return to the app, connect Freighter, and confirm the navbar shows the connected address.

## Common Commands

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `pnpm dev`                 | Start the local Next.js dev server                |
| `pnpm run lint`            | Run ESLint                                        |
| `pnpm run env:check`       | Verify `.env.local.example` covers env references |
| `pnpm run format:check`    | Check Prettier formatting                         |
| `pnpm test`                | Run Vitest                                        |
| `pnpm run test:a11y`       | Run accessibility tests                           |
| `pnpm run test:e2e`        | Run Playwright tests                              |
| `pnpm run build`           | Create a production build                         |
| `pnpm start`               | Serve the production build                        |
| `pnpm run storybook`       | Start Storybook on port 6006                      |
| `pnpm run build-storybook` | Build static Storybook output                     |

## Troubleshooting

### `pnpm install` does not set up hooks

Run:

```bash
pnpm exec husky
```

Then confirm `.husky/pre-commit` and `.husky/pre-push` are executable in your Git client.

### `npm install` changes lockfiles

Use pnpm for this repo. Remove any generated npm lockfile and reinstall:

```bash
rm package-lock.json
pnpm install
```

### Environment variables are not loading

Confirm `.env.local` exists at the repo root, uses `KEY=value` lines, and restart the dev server after changes.

```bash
pnpm dev
```

### Supabase or Resend routes fail locally

Reminder and notification routes are env-gated. Add the relevant Supabase and Resend keys to `.env.local`, or avoid those routes during basic UI work.

### `GET /api/reminders` returns unauthorized

Set `CRON_SECRET` in `.env.local` and call the route with:

```bash
Authorization: Bearer <CRON_SECRET>
```

### Freighter wallet does not connect

Unlock Freighter, switch it to **Testnet**, refresh the page, and reconnect. If the app reports a network mismatch, the configured `NEXT_PUBLIC_NETWORK_NAME` and the Freighter network are different.

### Testnet account has no funds

Use Friendbot with your Freighter public key. Testnet balances are separate from public network balances.

### Port 3000 is already in use

```bash
pnpm dev -- -p 3001
```

Then open [http://localhost:3001](http://localhost:3001).

### TypeScript fails on push

The pre-push hook runs `npx tsc --noEmit`. Reproduce it directly with:

```bash
pnpm exec tsc --noEmit
```

### Snapshot tests fail after intentional UI changes

Review the diff, then update snapshots intentionally:

```bash
pnpm test -- --update-snapshots
```

## Project Map

```
ILN-Frontend/
├── app/                    # Next.js App Router pages and API routes
├── src/components/         # Reusable UI, charts, forms, dashboards, stories
├── src/context/            # Wallet, notification, and toast providers
├── src/hooks/              # Custom hooks and React Query hooks
├── src/lib/                # Environment, Supabase, Horizon, events, wallet helpers
├── src/utils/              # Soroban, analytics, exports, risk, pagination helpers
├── __tests__/              # Vitest test suites
├── e2e/                    # Playwright journeys
├── docs/                   # Contributor documentation
├── public/                 # Static assets, screenshots, manifest, service worker
├── scripts/                # Repo maintenance scripts
└── .github/workflows/      # GitHub Actions workflows
```

## Next Steps

Start with `app/page.tsx`, skim [docs/architecture.md](architecture.md), and read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR. For deeper context on local integrations and contributor workflows, also see [docs/supabase-setup.md](supabase-setup.md), [docs/feature-flags.md](feature-flags.md), [docs/api-routes.md](api-routes.md), and [docs/testing.md](testing.md).
