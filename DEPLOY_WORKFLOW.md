# Carl Collaboration + Deploy Workflow

## Branches
- `main` = live production bot on VM
- `dev` = active development branch (PC/local work)

## Development (PC)
1. Work on `dev`
2. Commit + push to `origin/dev`
3. Open PR from `dev` -> `main`
4. Merge when ready to go live

## Production Deploy (VM)
Run from bot directory:

```bash
./deploy-live.sh
```

`deploy-live.sh` does:
1. `git fetch origin`
2. `git checkout main`
3. `git pull --ff-only origin main`
4. `pm2 restart solana-momentum-bot --update-env`
5. show PM2 status

## Emergency rollback (manual)
```bash
git checkout main
git log --oneline -n 5
# pick previous good commit
git reset --hard <commit_sha>
pm2 restart solana-momentum-bot --update-env
```

## Identity for commits from VM
Configured as:
- name: `Derek-Openclaw`
- email: GitHub noreply
