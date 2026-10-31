# bqto-action

[![CI](https://github.com/pilef-co/bqto-action/actions/workflows/ci.yml/badge.svg)](https://github.com/pilef-co/bqto-action/actions/workflows/ci.yml)

A GitHub Action that connects a job to a private Google Cloud database or
service through [bqto](https://github.com/pilef-co/bqto), with no service
account key, no VPN and no runner inside the VPC network.

bqto creates a short-lived bastion VM, opens a tunnel to it through
Identity-Aware Proxy (IAP) and deletes the VM when the session ends. The action
ships the free bqto binary for Linux, so the job installs nothing.

## Usage

This job runs a migration against a private Cloud SQL instance:

```yaml
jobs:
  migrate:
    runs-on: ubuntu-24.04
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: migrations@my-project.iam.gserviceaccount.com
      - uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1
      - uses: pilef-co/bqto-action@v1
        env:
          PGPASSWORD: ${{ secrets.DB_PASSWORD }}
        with:
          project: my-project
          instance: my-db
          run: ./migrate up
```

Replace `my-project`, `my-db`, the service account and `./migrate up` with your
own. [Setup](#setup) creates the provider, the service account and the
variables that the job uses.

The `run` command runs with bash:

- It gets the local address in `BQTO_HOST` and `BQTO_PORT`, and `PGHOST` and
  `PGPORT` for Cloud SQL and AlloyDB.
- The step fails when the command fails.
- bqto deletes the bastion VM when the command ends.

The database login is separate from bqto. Pass a password from your secrets, as
above, or an IAM token.

### Use the session in later steps

Without `run`, the step ends when the session is ready, and later steps of the
same job use it:

```yaml
      - id: db
        uses: pilef-co/bqto-action@v1
        with:
          project: my-project
          instance: my-db
      - run: ./migrate up
      - run: ./smoke-test --db "${{ steps.db.outputs.host }}:${{ steps.db.outputs.port }}"
```

Later steps get `BQTO_HOST` and `BQTO_PORT`, and `PGHOST` and `PGPORT` for
Cloud SQL and AlloyDB. The step also sets its [outputs](#outputs). At the end of
the job, the action stops bqto, which deletes the bastion VM.

### Which steps can reach the session

The session listens on `127.0.0.1` of the runner:

- Steps of the same job can reach it. Another job must run the action itself.
- `services:` containers and `uses: docker://` steps cannot reach it.
- In a job with `container:`, the session runs inside that container. The image
  needs gcloud 550.0.0 or later.

## Requirements

- A Linux runner, amd64 or arm64, that supports `node24` actions.
- gcloud 550.0.0 or later. GitHub-hosted Ubuntu runners have it. On other
  runners, `google-github-actions/setup-gcloud` installs it.
- `google-github-actions/auth` with `service_account`, then
  `google-github-actions/setup-gcloud`, before this action. Workload Identity
  Federation without a service account does not work with bqto.
- The requirements of bqto in your project: the APIs, the firewall rule for IAP
  and the roles. The [bqto README](https://github.com/pilef-co/bqto#requirements)
  lists them.

## Setup

Someone who can grant IAM roles in the project does this once. The provider
below gives a token only to the `production` environment of
`.github/workflows/deploy.yml`, run from `main` of your repository. Change the
condition to match your own workflow.

```sh
PROJECT=my-project
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
REPO=my-org/my-app
read -r REPO REPO_ID < <(gh api repos/$REPO --jq '"\(.full_name) \(.id)"')
SA=migrations@$PROJECT.iam.gserviceaccount.com

gcloud services enable compute.googleapis.com iap.googleapis.com oslogin.googleapis.com \
  cloudresourcemanager.googleapis.com sqladmin.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT

gcloud iam service-accounts create migrations --project $PROJECT

gcloud iam workload-identity-pools create github-deploy --project $PROJECT --location global
gcloud iam workload-identity-pools providers create-oidc github --project $PROJECT \
  --location global --workload-identity-pool github-deploy \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment,attribute.job_workflow_ref=assertion.job_workflow_ref \
  --attribute-condition "assertion.repository == '$REPO' && assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.job_workflow_ref == '$REPO/.github/workflows/deploy.yml@refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github-deploy/attribute.repository/$REPO"
```

The script reads `REPO` back from GitHub because the condition compares names
case-sensitively. After you rename the repository, update the condition and the
binding.

### Roles

Give the service account the
[minimal custom role](https://github.com/pilef-co/bqto/blob/main/docs/permissions.md#a-minimal-custom-role)
of bqto, limited to VMs and disks named `bqto-*` by the condition in
[Narrowing the grant](https://github.com/pilef-co/bqto/blob/main/docs/permissions.md#narrowing-the-grant).
Save them as `bqto-role.yaml` and `bqto-condition.yaml`, then:

```sh
gcloud iam roles create bqtoUser --project=$PROJECT --file=bqto-role.yaml
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA \
  --role=projects/$PROJECT/roles/bqtoUser --condition-from-file=bqto-condition.yaml
```

With Shared VPC, also grant the network project roles from
[docs/permissions.md](https://github.com/pilef-co/bqto/blob/main/docs/permissions.md#how-to-grant-it).
Do not give the account `roles/editor`.

### Repository settings

- Environments: create `production`, with required reviewers and deployments
  limited to `main`. Put `DB_PASSWORD` in its secrets.
- Secrets and variables, Actions, Variables: set `WIF_PROVIDER` to
  `projects/NUMBER/locations/global/workloadIdentityPools/github-deploy/providers/github`.

## Inputs

All inputs are optional. Set `instance`, or with bqto Pro, `profile` or
`stack`.

<!-- The inputs table comes from action.yml. -->
| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `instance` | no |  | Instance to reach, in the form that bqto connect --instance takes. Required unless profile or stack is set. |
| `service` | no |  | Service type: cloudsql, alloydb, redis or valkey. With edition pro, also cloudrun or kafka. bqto's default is cloudsql. |
| `project` | no |  | Google Cloud project ID. bqto's default is gcloud's project. |
| `run` | no |  | Command to run through the session, with bash. Without run, the session stays open for later steps of the job. |
| `duration` | no | `15m` | Maximum lifetime of the bastion VM. Compute Engine deletes the VM after this time, even if the job dies. |
| `network` | no |  | VPC network name, or projects/P/global/networks/N. bqto's default is the instance's network. |
| `region` | no |  | Region. bqto's default is the instance's region. |
| `zone` | no |  | Zone of the bastion VM. bqto's default is the first zone in the region with capacity. |
| `port` | no |  | Local port. bqto's default is the service's port + 10000. |
| `args` | no |  | Extra bqto connect flags, such as --debug. The action splits them into words as a shell does, with quotes and backslashes, but expands nothing. The action refuses --. |
| `edition` | no | `free` | Which bqto runs: free runs the bqto binary that this action ships, pro downloads the newest bqto Pro beta build from Artifact Registry with the job's gcloud account. |
| `profile` | no |  | bqto Pro: one or more saved profiles, separated by commas, in one session. |
| `stack` | no |  | bqto Pro: a saved stack of profiles, in one session. |
| `config` | no |  | bqto Pro: path to a bqto config.toml that holds the profiles and stacks, such as .github/bqto.toml. |
| `pro-project` | no | `prj-bqto-beta` | bqto Pro: project of the Artifact Registry repository that holds the beta builds. |
| `pro-location` | no | `europe-west1` | bqto Pro: location of the Artifact Registry repository. |
| `pro-repository` | no | `bqto-pro` | bqto Pro: name of the Artifact Registry repository. |

The action always passes `--no-input`. When runner debug logging is on, it also
passes `--debug`.

## Outputs

The action sets outputs only without `run`. They describe the first service of
the session. `sessions` has one entry for each service.

<!-- The outputs table comes from action.yml. -->
| Output | Description |
| --- | --- |
| `host` | Local host of the session. Set only without run. |
| `port` | Local port of the session. Set only without run. |
| `remote` | Address of the instance that the session reaches. Set only without run. |
| `bastion` | Name of the bastion VM. Set only without run. |
| `expires` | Time when Compute Engine deletes the bastion VM, in RFC 3339. Set only without run. |
| `proxy` | socks5 when the session is a SOCKS5 proxy (Cloud Run, Managed Kafka, clustered Redis or Valkey), else empty. Set only without run. |
| `sessions` | JSON array of bqto's ready events, one per service, with every field that bqto prints, such as tls and auth. Set only without run. |

To read one field of `sessions`, use an expression such as
`fromJSON(steps.db.outputs.sessions)[0].tls`.

## Security

- The job needs no service account key. It signs in with Workload Identity
  Federation.
- bqto deletes the bastion VM when the command ends, when the job ends and when
  someone cancels the job. If the runner kills bqto first, Compute Engine
  deletes the VM when `duration` runs out. Keep `duration` as short as the job
  allows.
- The free bqto binaries in `bin/` come from a bqto release, and CI checks them
  against the `checksums.txt` of that release.
- Every port that bqto opens listens on `127.0.0.1`. On a self-hosted runner
  that runs several jobs on one machine, another job can use your session. Use
  runners that run one job for each VM.

Pin the action to a full commit SHA, as you do for other actions that get
credentials:

```yaml
      - uses: pilef-co/bqto-action@FULL_COMMIT_SHA # v1.0.0
```

[docs/security.md](https://github.com/pilef-co/bqto/blob/main/docs/security.md)
says what bqto does with your identity, network and data. To report a
vulnerability, follow the
[bqto security policy](https://github.com/pilef-co/bqto/blob/main/SECURITY.md).

## Versioning

Each release has a `v1.x.y` tag. The `v1` tag moves to the newest `v1.x.y`
release. A change that can break a working workflow gets `v2`.

## Other CI systems

On GitLab CI, Cloud Build, Jenkins and other CI systems, install bqto and run
`bqto connect --no-input ... -- CMD`, as the
[bqto README](https://github.com/pilef-co/bqto#readme) shows.

## bqto Pro

bqto Pro is the paid build of bqto, now in beta. To try it, join the beta at
https://bqto.dev/#waitlist. With `edition: pro`, the action downloads the newest
bqto Pro build, checks it against its `checksums.txt` and runs it in place of
the free bqto. The service account of the job needs
`roles/artifactregistry.reader` on the beta repository, which Pilef grants
during the beta.

```yaml
      - uses: pilef-co/bqto-action@v1
        with:
          edition: pro
          service: cloudrun
          project: my-project
          instance: europe-west1/api
          run: curl -fsS https://api-123456.europe-west1.run.app/healthz
```

What the action does differently with bqto Pro:

- Cloud Run, Managed Kafka and Memorystore clusters go through a SOCKS5 proxy.
  With `run`, the command gets `ALL_PROXY` and `HTTPS_PROXY`. Without `run`,
  later steps get `BQTO_PROXY`, and the `proxy` output is `socks5`.
- Profiles and stacks come from the `config` file in your repository, which
  holds no secrets. To use several services, leave out `run` and use the session
  in later steps.
- With `run`, the action refuses `--web`, because bqto prints the web proxy
  secret. Without `run`, it masks `web_token` in the log.
- After the last day of the beta, the build works as the free bqto, and the
  action shows a warning.

The bqto Pro README, in each build, has the details of each feature.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to test the action and update the
bqto binaries.

## License

The action and the bqto binaries in `bin/` are licensed under the
[Apache License 2.0](LICENSE). bqto Pro is a separate product with its own
terms.
