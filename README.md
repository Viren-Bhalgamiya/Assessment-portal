# Assessment Portal

A proctored multiple-choice exam portal.

- **Students** register with their email ID, wait for admin approval, then pass device checks: camera, entire-screen share and a single monitor. They take the exam in fullscreen in a standard CBT layout, with section tabs, a question palette, mark-for-review and a server-side timer.
- **Admins** approve registrations, manage the question bank, open or close the exam, watch attempts live, and see scores, answers, warnings and camera/screen snapshots.
- **Students never see their score.** The answer key never leaves the server.

> **Testing the portal?** Follow [TESTING.md](TESTING.md): setup from the zip, step-by-step test cases, and how to report bugs.

> **Deploying to Azure?** Follow [AZURE.md](AZURE.md): App Service + PostgreSQL + Blob Storage, step by step.

## Run locally

Requires Node.js **22.13 or newer**. The app uses Node's built-in SQLite, so there is nothing native to compile.

```bash
npm install
npm run create-admin -- admin "ChooseAStrongPassword" "Exam Admin"
npm start
```

Open http://localhost:3000 and sign in as the admin.

## Deploy: Render (server) + Vercel (pages)

```
student browser ──HTTPS──▶ Vercel (static pages)  ──/api/*──▶  Render (Node server + disk)
                                                                  ├─ SQLite database
                                                                  └─ camera / screen snapshots
```

Vercel serves the pages and forwards every `/api/...` request to Render. The browser only ever talks to the Vercel domain, so login cookies stay first-party and no cross-site setup is needed.

### 1. Render: the API server

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository. `render.yaml` creates:
   - a **web service** on the *Standard* plan (1 CPU, 2 GB) running `node server.js` with health check `/healthz`;
   - a **20 GB persistent disk** mounted at `/var/data` for the database and snapshots.
3. In the service's **Environment** tab, set `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The first admin account is created from these on the first start.
4. Note the service URL, for example `https://assessment-portal-api.onrender.com`.

Run **one instance only**. The database lives on the attached disk, so don't enable autoscaling. For more headroom, use a bigger plan instead (see *Capacity* below).

### 2. Vercel: the pages

1. In `vercel.json`, replace `REPLACE-WITH-YOUR-RENDER-SERVICE.onrender.com` with your Render host.
2. Import the same repository in Vercel. No build step is needed: `vercel.json` publishes the `public/` folder and adds the security headers.
3. Share the Vercel URL, for example `https://your-portal.vercel.app`, with students.

Students can also use the Render URL directly. In that case, set `TRUST_PROXY=1` on Render so IP addresses are logged correctly.

### Environment variables (Render)

| Variable | Value in `render.yaml` | Purpose |
|---|---|---|
| `DATA_DIR` | `/var/data` | Where the SQLite database and snapshots are stored (the persistent disk) |
| `COOKIE_SECURE` | `1` | Cookies only over HTTPS |
| `TRUST_PROXY` | `2` | Proxy hops in front of the app: 2 for Vercel → Render, 1 for Render only |
| `UV_THREADPOOL_SIZE` | `16` | Parallel password hashing and compression during the login rush |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | set in dashboard | Creates the first admin on first start |
| `PORT` | set by Render | HTTP port |

## Capacity: tested with 1,000 simultaneous students

The load test simulated 1,000 students. Each one:
- registered, logged in and started the exam **at the same moment**;
- wrote the exam for 3 minutes (a heartbeat every 20 s, an answer every ~12 s, a camera and screen photo every 60 s) while the admin dashboard refreshed every 15 s;
- then submitted at the same moment as everyone else.

| Phase | Result |
|---|---|
| Total | **0 errors** in about 33,000 requests; **1,000/1,000** exams submitted and scored |
| During the exam (server time, 99% of requests) | answer save < 5 ms, heartbeat < 3 ms, event < 7 ms |
| Everyone clicks Start together | all 1,000 exams open within about 2 s of server time |
| Everyone logs in in the same second | up to about 3.5 s; password checking is deliberately CPU-heavy |
| Everyone submits together | submit < 5 ms server time each |
| Server memory | about 300 MB peak |

That test ran on a multi-core laptop. On Render's 1-CPU *Standard* plan the exam itself has plenty of headroom (it averaged well under one core). A 1,000-student login in the **same second** would take noticeably longer there. Either:
- ask students to sign in during a 10-minute window before you open the exam (the normal pattern, and the load is trivial), or
- use the 2-CPU *Pro* plan for the exam day.

**Storage:** snapshots are about 15 KB (camera) and 60 KB (screen) each. At the default 60-second interval that's about 11 MB per student for 150 minutes, or about 11 GB for 1,000 students. The 20 GB disk covers one full exam. Download the results CSV and delete old students (or old attempts) between exams to free space.

**Live metrics:** admins can open `/api/admin/metrics` during the exam to see server-side response times per route, event-loop delay, memory, open connections and live attempts.

## Running an exam

1. Students open the site, choose **Register**, and enter email ID, name and password. They see "Waiting for approval".
2. **Students & approvals:** approve each student, or use **Approve all**. The student's page moves on by itself. Turn **Registration is open** off once everyone has registered.
3. **Questions:** add, edit or delete questions (code, statements, four options, the correct answer, a worked solution, and the question's marks: marks for a correct answer and negative marks for a wrong one, default +4 / −1, decimals allowed). **Set marks** on a section changes all its questions at once. Adding and deleting are disabled while students are mid-exam. Changing a correct answer or marks re-scores submitted exams.
4. **Exam settings:** timing, warning limit (1–3, default 3) and snapshot interval (default 60 s). Turn **Exam is open** on when students should start. Timing is one of:
   - **One timer for the whole exam** (default duration 150 min). Students move freely between all sections.
   - **A separate timer for each section.** Set each section's minutes with **Set time** in **Questions → Sections**; the total time is the sum. Students take the sections in order. When a section's time ends, or they click **Finish section**, it locks and they move to the next; unused time is not carried over. The server refuses answers to closed or future sections. The exam can't be opened until every section with questions has a time.
5. **Results & monitoring:** live progress (refreshes every 15 s). **View** shows a student's score by section, every answer against the key, the proctoring log and snapshots. **Download results (CSV)** exports everything.

## Use-case round (non-engineering candidates)

The portal runs one test type at a time. Choose it under **Configuration → Test Type**:

- **MCQ Test**: the proctored multiple-choice test described above.
- **Use-Case Round**: timed and not proctored (no webcam, screen sharing, full screen or warnings).

To run the use-case round:

1. **Use Cases** tab: add the use cases. Each has a title plus a description, a PDF (up to 25 MB), or both. You can edit them at any time. A use case that has been assigned to a candidate can't be deleted.
2. **Configuration:** choose **Use-Case Round**, set the duration and maximum marks, and turn **Test is open** on. The round can't be opened until at least one use case exists. The test type can't be switched while any candidate is mid-test.
3. Each candidate reads the instructions and clicks **Start**. They are given one use case at random, shown with its PDF, and a timer. They paste **one link** to their solution and submit it once. The timer is kept on the server, and the attempt closes when time runs out.
4. **Dashboard & Results** lists every candidate with their use case, submission time and link. Open the link, enter the marks and remarks, and click **Save**. **Export Results (CSV)** includes links, marks and remarks. **Close Attempt** ends a candidate's attempt early. **Allow Re-attempt** (Candidates tab) clears a candidate's attempt.

## What the proctoring does

| Rule | How it is enforced |
|---|---|
| Authentication | Self-registration with admin approval, scrypt-hashed passwords, HttpOnly SameSite cookies, lockout after 8 failed logins, one active session per student |
| Warning limit | At most **3** warnings (configurable 1–3). Reaching the limit submits the exam automatically, with no retake. |
| Tab / window switching | Leaving the page or window is a warning. A screen snapshot is taken right after to show what the student switched to. |
| Fullscreen | The exam runs in fullscreen. Leaving it is a warning and blocks the exam until the student returns. A tab switch that also drops fullscreen counts once. |
| Copy / paste | Copy, cut, paste, right-click, Ctrl/Cmd+C/V/X/A and PrintScreen are blocked **and each is a warning**. Other shortcuts (F12, print, save, view-source) are blocked and logged. |
| Reload / reopen | Reopening the exam page mid-exam is a warning. The resume screen is also monitored. |
| Camera | A live camera preview stays on screen. If the camera stops or freezes for more than 8 s, that's a warning and the exam is blocked until the camera is back. |
| Microphone | Required before the test can start, with a live level meter. If the microphone stops or is muted for more than 8 s, that's a warning and the exam is blocked until it is back. When sustained speech or sound is detected, it is logged (not a warning, so background noise never auto-submits a test) and a 10-second audio clip is saved; the admin can play the clips in the candidate's detail view. |
| Screen sharing | The student must share the **entire screen**. If sharing stops, that's a warning and the exam is blocked until they share again. |
| Single monitor | A second display blocks the start and is a warning mid-exam (Chrome and Edge). |
| Snapshots | A camera and a screen photo at the set interval and at every warning. The server flags students whose photos stop arriving. |
| Tampering | The exam code is not reachable from the browser console. It reads the browser's own visibility, focus and fullscreen state, which can't be spoofed by redefining `document.hidden` and similar. Its listeners run before anything added later, so they can't be silenced. Warnings carry unique ids and are re-sent with every answer save and heartbeat. Forged events can't hide real ones. |
| Flooding | Each student is rate-limited, so a script hammering the server gets `429` responses without slowing anyone else down. |
| Timer | The deadline is stored on the server. Reloading doesn't stop it, and the server auto-submits at the deadline even if the browser is gone. |
| Anti-copying between students | Per-student question order within each section, and shuffled options |
| Results hidden | Students only ever see "submitted". Scores, the key and snapshots are admin-only. |

A web page cannot see a phone on the desk or another person in the room, and cannot block Alt+Tab or the Windows key. The portal **detects and records** these through warnings and snapshots; it cannot always prevent them. Keep invigilators in the room for high-stakes exams.

## Project layout

```
server.js            API, sessions, scoring, auto-submit sweeper, metrics
db.js                SQLite schema, settings cache, prepared-statement cache
auth.js              password hashing (async scrypt)
questions.js         question bank stored in the database (admin-managed)
questions-data.js    the original 44 questions, used to fill an empty database
usecases.js          use-case round: use cases, PDFs (DATA_DIR/usecases) and attempts
scripts/create-admin.js
public/              login, exam and admin pages, plus CSS and JS
render.yaml          Render blueprint (web service + disk)
vercel.json          Vercel config (static pages + /api proxy to Render)
```
