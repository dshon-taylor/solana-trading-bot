# Deploy Workflow

## Branch policy

- `main` is production.
- Use feature branches for local work and merge to `main` when validated.

## Standard production deploy

From repo root:

```bash
./scripts/ops/deploy-live.sh
```

Expected steps:

1. fetch latest `main`
2. fast-forward pull
3. PM2 restart with updated env
4. show status

## Recommended pre-deploy check

```bash
npm run check
npm run test
```

## Recommended post-deploy check

```bash
pm2 status
curl -sS http://127.0.0.1:8787/healthz | jq
pm2 logs solana-momentum-bot --lines 120
```

## Emergency rollback

```bash
git checkout main
git log --oneline -n 10
git reset --hard <known_good_commit>
pm2 restart solana-momentum-bot --update-env
```
