#!/usr/bin/env bash
# One-shot setup for the chat MVP.
# Runs the deterministic steps; the last two need YOUR Convex/Clerk accounts.
set -e

cd "$(dirname "$0")"

echo "==> Installing dependencies"
pnpm install

if [ ! -f .env.local ]; then
  cp .env.local.example .env.local
  echo "==> Created .env.local (fill in your Clerk keys)"
else
  echo "==> .env.local already exists, leaving it alone"
fi

cat <<'EOF'

============================================================
 Automated steps done. Three things left (need your logins):
============================================================

1) Start Convex — logs you in, writes NEXT_PUBLIC_CONVEX_URL into
   .env.local, and generates convex/_generated:

     npx convex dev      # leave this running in its own terminal

2) Clerk (https://dashboard.clerk.com):
   - Create an application
   - Copy the Publishable key + Secret key into .env.local
   - Create a JWT template named EXACTLY:  convex
   - Copy that template's Issuer URL, then run:

     npx convex env set CLERK_JWT_ISSUER_DOMAIN <issuer-url>

3) Run the app (new terminal, with `npx convex dev` still running):

     npm run dev

   Then open http://localhost:3000/dashboard
============================================================
EOF
