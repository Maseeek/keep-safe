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

Vercel MCP account access was verified on 16 October 2026. No Vercel project has been created for this app yet.

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

Current scheduler state: no recurring task is configured for this project.
