# Deploying to Azure (App Service + PostgreSQL + Blob Storage)

The portal runs on Azure as **one App Service**. It serves both the pages and the API.

It needs three Azure resources:

| Resource | What it stores | Suggested size for about 1,000 students |
|---|---|---|
| **Azure Database for PostgreSQL – Flexible Server** | Candidates, attempts, answers, scores, settings, questions, use cases | Burstable **B2s** (B1ms is enough for testing) |
| **Storage account** (Blob Storage) | Webcam/screen snapshots, audio clips, use-case PDFs | Standard, LRS |
| **App Service** (Linux, Node) | The portal itself | **P0v3** or **B2** (B1 is enough for testing) |

When the app sees the `PGHOST` (or `DATABASE_URL`) and `AZURE_STORAGE_CONNECTION_STRING` settings, it uses PostgreSQL and Blob Storage automatically. Without `AZURE_STORAGE_CONNECTION_STRING`, files go to `DATA_DIR` (set it to `/home/data` on App Service). Without them it falls back to SQLite and the local disk, which is how it runs locally.

Create all three resources in the **same region** and the **same resource group**, for example `assessment-portal-rg` in Central India.

---

## 1. PostgreSQL

1. Azure portal → **Create a resource** → **Azure Database for PostgreSQL** → **Flexible server** → **Create**.
2. On the **Basics** tab:
   - **Server name:** for example `assessment-portal-db`
   - **PostgreSQL version:** 16 or 17
   - **Workload type:** Development (for testing) or Production
   - **Compute + storage:** **Burstable, B2s** (B1ms for testing). 32 GB of storage is plenty.
   - **Authentication:** PostgreSQL authentication only. Choose an **admin username and password, and save them**.
3. On the **Networking** tab:
   - **Connectivity method:** Public access
   - Tick **Allow public access from any Azure service within Azure to this server**.
4. Click **Review + create**, then **Create**. It takes about 5–10 minutes.
5. When it is ready, open the server → **Databases** → **+ Add** → name it `portal` → **Save**.
6. Note the server's **Server name** from its **Overview** page (`<server-name>.postgres.database.azure.com`), plus the admin login and password. They go into the App Service settings in step 3.1.

The app creates all its tables itself the first time it starts.

## 2. Storage account

1. **Create a resource** → **Storage account** → **Create**.
2. Fill in the **Basics** tab:
   - **Storage account name:** for example `assessmentportalfiles`. It must be lowercase and globally unique.
   - **Performance:** Standard
   - **Redundancy:** LRS
3. Click **Review + create**, then **Create**.
4. Open the storage account → **Security + networking → Access keys** → **Show** next to **Connection string** for key1, and copy it. This is `AZURE_STORAGE_CONNECTION_STRING`.

The app creates a private container called `portal` on first start. Files are never public; they are only served through the app to signed-in admins and candidates.

## 3. App Service

1. **Create a resource** → **Web App** → **Create**.
2. On the **Basics** tab:
   - **Name:** for example `assessment-portal`. The site will be `https://assessment-portal.azurewebsites.net`, or a similar address that Azure shows you.
   - **Publish:** Code
   - **Runtime stack:** **Node 22 LTS** (or newer)
   - **Operating system:** **Linux**
   - **Region:** the same region as the database
   - **Pricing plan:** **P0v3** or **B2** (B1 for testing)
3. Click **Review + create**, then **Create**.

### 3.1 Settings (environment variables)

Open the Web App → **Settings → Environment variables** → **App settings**. Add each of these, then click **Apply**:

| Name | Value |
|---|---|
| `PGHOST` | `<server-name>.postgres.database.azure.com` |
| `PGUSER` | the PostgreSQL admin login |
| `PGPASSWORD` | the PostgreSQL admin password, exactly as typed (any characters are fine) |
| `PGDATABASE` | `portal` |
| `AZURE_STORAGE_CONNECTION_STRING` | the connection string from step 2 |
| `ADMIN_USERNAME` | the admin login, e.g. `admin` |
| `ADMIN_PASSWORD` | a strong admin password. It is used only to create the first admin. |
| `COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1` |
| `UV_THREADPOOL_SIZE` | `16` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |

### 3.2 General settings

Open the Web App → **Settings → Configuration → General settings**:

- **Startup Command:** `npm start`
- **Always On:** **On**. This is important: it keeps the app awake, so tests are auto-submitted when their time runs out.
- **HTTPS Only:** **On**
- Click **Save**.

### 3.3 Health check

Web App → **Monitoring → Health check** → **Enable** → **Path:** `/healthz` → **Save**.

### 3.4 Keep it to one instance

Web App → **Settings → Scale out** → set the instance count to **1**.

The app keeps its auto-submit timer, rate limits and login lockout in memory, so it must run as a single instance. To handle more load, scale **up** to a bigger plan instead of out.

---

## 4. Deploy the code from GitHub

1. Web App → **Deployment → Deployment Center**.
2. **Source:** GitHub. Sign in to GitHub and authorise Azure.
3. Choose **Organization:** your account, **Repository:** `Assessment-portal`, **Branch:** `main`.
4. Click **Save**. Azure adds a GitHub Actions workflow to the repository and starts the first deployment.

From then on, every push to `main` redeploys the app automatically. You can watch progress in **Deployment Center → Logs**, or on the repository's **Actions** tab.

## 5. Check it

1. Open `https://<your-app>.azurewebsites.net/healthz`. It should show `{"ok":true}`.
2. Open `https://<your-app>.azurewebsites.net` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
3. Web App → **Monitoring → Log stream** should show:
   ```
   Database: PostgreSQL · Files: Azure Blob Storage
   Assessment portal running on http://localhost:8080
   ```
4. Run through the checks in [TESTING.md](TESTING.md) using the Azure address instead of `localhost:3000`.

Give students the `https://…azurewebsites.net` address. They need Chrome or Edge on a laptop or desktop.

---

## Frontend on Azure Static Web Apps (optional)

The App Service can serve the pages itself, so this is optional. To serve the pages (the `public` folder) from a Static Web App, with the App Service as the backend:

1. **Create a resource** → **Static Web App** → **Create**.
   - **Plan type:** **Standard**. This is required for linking a backend.
   - **Deployment source:** GitHub → repository `Assessment-portal`, branch `main`.
   - **Build presets:** Custom
   - **App location:** `public`
   - **Api location:** leave empty
   - **Output location:** leave empty
2. When it's created, open the Static Web App → **Settings → APIs** → on the **Production** row click **Link** → **Backend resource type:** Web App → choose the App Service → **Link**.
   From now on, `https://<static-web-app>/api/*` is forwarded to the App Service on the same address, so the login cookie works.
3. On the App Service, set `TRUST_PROXY` to **`2`** (Static Web App + App Service front end), then restart it.
4. Give students the **Static Web App address**.

`public/staticwebapp.config.json` maps `/exam` and `/admin` to their pages and sets the same security headers the App Service uses.

> Linking restricts the App Service so it only accepts traffic through the Static Web App. Its own `*.azurewebsites.net` address then stops serving the portal directly, which is expected.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site shows "Application Error" or 503 | Open **Log stream** and look for `Startup failed:`. Usually a `PG…` setting is wrong, or the `portal` database doesn't exist. |
| `no pg_hba.conf entry` or a timeout connecting to the database | PostgreSQL → **Networking** → tick **Allow public access from any Azure service**. |
| Can't sign in (the page reloads to the login page) | Make sure you are using the `https://` address. `COOKIE_SECURE=1` needs HTTPS. |
| Tests are not auto-submitted when time runs out | Turn **Always On** on. |
| Camera, microphone or screen sharing doesn't work | Use the `https://` address in Chrome or Edge. |

## Local development

Nothing changes locally: `npm install`, `npm run create-admin -- admin <password> "Admin"`, `npm start`. Data stays in `./data` (SQLite and files).

To run locally against PostgreSQL or Blob Storage, set the same `DATABASE_URL` / `AZURE_STORAGE_CONNECTION_STRING` variables before `npm start`. Add `?sslmode=disable` to `DATABASE_URL` for a local PostgreSQL without SSL.
