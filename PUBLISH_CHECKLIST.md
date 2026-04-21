# OmniCrawl Publish Checklist

## Before First GitHub Push

- Make `C:\Users\Administrator\omnicrawl` an independent git repository, or copy it into a clean standalone directory first.
- Optional shortcut on Windows: run `npm run prepare:github` to export a clean standalone copy to `C:\Users\Administrator\omnicrawl-github`.
- If you want the exported copy to be immediately commit-ready, run `npm run prepare:github:init`.
- Confirm `node_modules/`, `runs/`, `.omnicrawl/`, local databases, logs, and `.env*` are not staged.
- Review `README.md` once more and keep the current `stable / advanced / experimental` wording.
- If you publish Docker examples, set `GF_SECURITY_ADMIN_PASSWORD` to a real secret before sharing screenshots or demos.

## Before Tagging a Release

- Run `npm run check`
- Run `npm test`
- Run `npm run test:api`
- Skim `deploy/docker/docker-compose.yml` and `Dockerfile` after any port/env changes

## Manual Publish Notes

- The repository URL in `package.json` should match the final GitHub repo.
- If you plan to publish to npm, verify `files` in `package.json` still matches the intended package surface.
- If the repo stays monorepo-nested, do not push from `C:\Users\Administrator`; push from a clean standalone repo root.
