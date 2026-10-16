# Delivery workflow

## Implement and document

Use the owner's answers in [alignment.md](alignment.md) to define the first complete user workflow. Record any implementation assumptions and keep a short backlog of the next useful improvements.

Ship changes in coherent commits. Update the README when a change affects setup, commands, capabilities, limitations, or deployment. Record meaningful changes in the [change history](../CHANGELOG.md).

Do not document planned features as available. Setup commands should be copied from commands that have actually been run successfully.

## Verify

Choose checks that cover the implementation. For application changes, verify the main user workflow, failure states, and any data persistence that it depends on. Add automated tests where they protect important behavior.

For a web app, inspect the running app in the collaborative browser and check mobile and desktop layouts. Check keyboard access and readable form errors. Record any part of the flow that could not be verified.

## Publish to GitHub

The repository is [Maseeek/keep-safe](https://github.com/Maseeek/keep-safe). Preserve its private visibility until the owner chooses otherwise. Do not add a licence on the owner's behalf before that decision.

Inspect the working tree and remote state before pushing. Keep secrets and deployment credentials out of source control. Leave unrelated user files untouched.

If a pull request is created or worked on, register its URL with the T3 thread through the available pull request linking tools. Do not report a pull request as linked if registration fails.

## Deploy through Vercel MCP

Vercel project `keep-safe` (`prj_zW8M93fOJrh1lzeaqZGgzfJKm9L3`) belongs to team `team_MqtKrcIvH0Rzo9p8g3ai1lY9`. Production is [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app). The private GitHub repository is connected to this project. Use the direct Vercel MCP connection with this explicit scope.

Before deployment:

1. Confirm the intended Vercel team, project, source commit, and deployment environment.
2. Run the application's required checks and build.
3. Use authenticated Vercel MCP tools to create or update the deployment.
4. Inspect the returned deployment until its state is terminal. For a failed build, inspect the build logs before retrying.
5. Verify the deployed app's main workflow at its actual URL.
6. Add the verified production URL to the README and the GitHub repository website field.

An accepted deployment request is not proof that the app is live. Keep the last verified deployment available while resolving a failed update.

## Continue while the owner is away

Use the T3 persistent scheduler once the product brief, runtime availability, allowed services, spending cap, and stop date are recorded. Bind continuation runs to the current thread so they retain the project's context.

Before creating a recurring task, inspect existing scheduled tasks to avoid duplicates. Save the returned task ID, next run time, and end date in this document. A proposed schedule is not an active schedule.

Each continuation should inspect current files, GitHub state, and any live work before starting. Continue useful work against the agreed brief, resolve failures, and leave an accurate progress record. Check the stop date before starting new work and disable the recurring task when the agreed window ends.

## Current scheduler

- Recurring task: `scheduled-task:command:mcp:980aceb3-4f95-4e71-b6e6-5771dca48ec6:schedule-task:keep-safe-autonomy-20261016-until-20261024`
- Bound to the current T3 thread; runs hourly.
- First scheduled continuation: 16 October 2026 at 15:00 UTC / 16:00 London.
- Stop time: 24 October 2026 at 08:00 UTC / 09:00 London. Every trigger must check the clock before work, disable the task at the deadline, and cancel any child work from this project.
- These are task instructions, not an unconditional guarantee of host availability. The environment must remain running for scheduled work.

The accepted brief is now in [alignment.md](alignment.md). The original questions have been answered.

Continuation prompts can contain an older handoff. Prefer the current checkout and the latest entries in [progress.md](progress.md), then verify deployment state. The phone keys have a fixed seven-day expiry; an earlier chat summary's claim of a 30-day sliding expiry was incorrect.
