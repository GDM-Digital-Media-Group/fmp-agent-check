# Agent file check

Checks the agent instruction files a pull request changes (CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules, .github/copilot-instructions.md and GEMINI.md) and comments a score and the problems it found on the pull request. A later push is checked again only when it changes an agent file, and the comment is updated, not repeated.

A pull request that changes none of those files is skipped and uses nothing from your allowance.

## Set up

1. Create a key at https://fixmyprompt.net/app?settings=ci (section "GitHub checks").
2. In your repository, open Settings, Secrets and variables, Actions, and add a repository secret named `FMP_KEY` with the key.
3. Add this workflow as `.github/workflows/agent-check.yml`:

```yaml
name: Agent file check
on:
  pull_request:
    paths:
      - "**/CLAUDE.md"
      - "**/AGENTS.md"
      - ".cursorrules"
      - ".cursor/rules/**"
      - ".github/copilot-instructions.md"
      - "GEMINI.md"

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: GDM-Digital-Media-Group/fmp-agent-check@v1
        with:
          fmp-key: ${{ secrets.FMP_KEY }}
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `fmp-key` | yes | | Your CI key. Keep it in a secret. |
| `fail-below` | no | | Fail the check when the score is under this number. It applies only to a score. |
| `api-url` | no | `https://fixmyprompt.net` | FixMyPrompt address. |

## What it costs

Free accounts get 5 pull request checks a month: one analysis of all the changed agent files together, with the score, the token cost and the top 3 problems. Pro shows every finding and is paid from credits.

## Notes

- The files are read from the checkout, so run `actions/checkout` first. Changed files are listed with the GitHub API and `GITHUB_TOKEN`.
- Pull requests from forks do not receive repository secrets. The action logs that and skips.
- If FixMyPrompt cannot be reached, or your free checks are used up, the check passes. The action logs why.
- If the key is not valid, the pull request comment says so in plain words. When your free checks are used up, an earlier result comment is kept as it is; with none, the comment says so.
- The action uses only Node built-ins. It never prints your key.

Maintained by GDM Digital Media Group.
