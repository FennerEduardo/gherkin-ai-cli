# Standard benchmark tasks (`ghk bench`)

Three tasks with the same domain and the same hidden acceptance test, one per stack, so results can be compared across stacks and published.

| Task | Stack | Build | Acceptance |
|---|---|---|---|
| `orders-express` | TypeScript, Express 5 | `npm run build` | `npm start` |
| `orders-spring` | Java 17, Spring Boot | `mvn package` | `java -jar target/*.jar` |
| `orders-fastapi` | Python 3.12, FastAPI | `pip install -r requirements.txt` | `uvicorn app.main:app` |

Each folder has `REQUIREMENTS.md` (the brief both arms get), `features/orders.feature` (what the ghk arm also gets), and `acceptance/http-acceptance.mjs`, copied in only after the agent finishes. The acceptance test is black-box over HTTP and identical in the three tasks (`shared/`): it starts the service and checks 9 behaviours of the contract (201, 401, 422 twice, 200, 200, 409, 404, health). It passes 9/9 against a reference implementation of the contract.

## Run

```bash
ghk bench run evals/bench/orders-express          # control and ghk arms, 3 repetitions each
ghk bench run evals/bench/orders-express --dry-run  # prepare the workspaces without starting the agent
```

`bench.json` runs Claude Code by default; change `agent` to your agent's non-interactive command (`{prompt_file}`, `{workspace}` and `{arm}` are substituted). Model costs come only from that command.

## Publish

Publish `report.md` with what is needed to reproduce it: the agent and model version, the gherkin-ai version, the machine, the number of repetitions, and every run (not only the best). The harness does not hide failed runs, and neither should a report.
