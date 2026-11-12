# Delivery workflow

## Implement and document

Use the owner's answers in [alignment.md](alignment.md) to define the first complete user workflow. Record any implementation assumptions and keep a short backlog of the next useful improvements.

Ship changes in coherent commits. Update the README when a change affects setup, commands, capabilities, limitations, or deployment. Record meaningful changes in the [change history](../CHANGELOG.md).

Do not document planned features as available. Setup commands should be copied from commands that have actually been run successfully.

## Verify

Choose checks that cover the implementation. For application changes, verify the main user workflow, failure states, and any data persistence that it depends on. Add automated tests where they protect important behavior.

For a web app, inspect the running app in the collaborative browser and check mobile and desktop layouts. Check keyboard access and readable form errors. Record any part of the flow that could not be verified.

## Publish to GitHub

The repository is [Maseeek/keep-safe](https://github.com/Maseeek/keep-safe).

Inspect the working tree and remote state before pushing. Keep secrets and deployment credentials out of source control. Leave unrelated user files untouched.

If a pull request is created or worked on, register its URL with the T3 thread through the available pull request linking tools. Do not report a pull request as linked if registration fails.

## Deploy through Vercel MCP

Vercel project `keep-safe` (`prj_zW8M93fOJrh1lzeaqZGgzfJKm9L3`) belongs to team `team_MqtKrcIvH0Rzo9p8g3ai1lY9`. Production is [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app). The GitHub repository is connected to this project. Use the direct Vercel MCP connection with this explicit scope.

Before deployment:

1. Confirm the intended Vercel team, project, source commit, and deployment environment.
2. Run the application's required checks and build.
3. Use authenticated Vercel MCP tools to create or update the deployment.
4. Inspect the returned deployment until its state is terminal. For a failed build, inspect the build logs before retrying.
5. Verify the deployed app's main workflow at its actual URL.
6. Add the verified production URL to the README and the GitHub repository website field.

An accepted deployment request is not proof that the app is live. Keep the last verified deployment available while resolving a failed update.
