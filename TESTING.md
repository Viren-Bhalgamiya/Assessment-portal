# Testing Guide: Assessment Portal

This guide explains how to run the portal on your own computer and what to test. Work through it top to bottom. Every test says what to do and what should happen. If something different happens, write it down using the bug-report format at the end.

The portal has two test types. The admin chooses one in **Configuration → Test Type**:

| Test type | Who it is for | What the candidate does |
|---|---|---|
| **MCQ Test** | Engineering candidates | A timed multiple-choice test that is fully proctored: webcam, microphone, screen sharing, full screen, and at most 3 warnings before automatic submission. |
| **Use-Case Round** | Other candidates | Gets one of the use cases at random, works on it within the time limit, and submits **one link**. There is no proctoring. The examiner enters the marks. |

---

## 1. Set up (about 10 minutes)

### 1.1 What you need

- A **Windows, Mac or Linux laptop or desktop** with a **webcam and a microphone**. A headset microphone is fine. Phones and tablets are blocked by design.
- **Google Chrome** or **Microsoft Edge** (latest version). The tests below use both: one for the admin and one for the candidate.
- **Node.js 22.13 or newer.** Download the LTS version from https://nodejs.org and install it with the default options.
  Check the version in a terminal (on Windows use **Command Prompt** or **PowerShell**):
  ```
  node -v
  ```
  It must print `v22.13.0` or higher (for example `v22.x` or `v24.x`).

### 1.2 Unzip and install

1. Unzip the folder you were given, for example to `C:\portal` or your Desktop.
   Do **not** run it from inside the zip file.
2. Open a terminal **in the unzipped folder**, which is the folder that contains `package.json`.
   - Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
   - Mac/Linux: `cd` into the folder.
3. Install the dependencies. This needs an internet connection and runs only once:
   ```
   npm install
   ```
4. Create your admin account. You can choose any username and password:
   ```
   npm run create-admin -- admin Admin@123 "Test Admin"
   ```
   It should print `Admin "admin" created.`
5. Start the portal:
   ```
   npm start
   ```
   It should print `Assessment portal running on http://localhost:3000`.
   **Leave this terminal open** while you test. Closing it stops the portal.

### 1.3 Open it

Open **http://localhost:3000** in Chrome.

> **Important:** always use `http://localhost:3000`. The webcam, microphone and screen sharing only work on `localhost` or a proper `https://` address. The MCQ test will not work if you open the portal from another computer using an IP address such as `http://192.168.x.x:3000`.

### 1.4 Admin and candidate at the same time

Each browser keeps one login at a time. To be the admin and a candidate together:

- **Admin:** a normal **Chrome** window.
- **Candidate 1:** **Microsoft Edge**, or a Chrome **Incognito** window (Ctrl+Shift+N).
- **More candidates:** another browser or another Chrome profile. Incognito windows share one login with each other.

### 1.5 Starting again from a clean state

1. Stop the portal (Ctrl+C in the terminal).
2. Delete the `data` folder inside the project folder. It holds the database, snapshots, audio and PDFs.
3. Run `npm run create-admin -- admin Admin@123 "Test Admin"` again.
4. Run `npm start`.

### 1.6 Sample use cases

The `sample-usecases` folder has 4 ready-made problem-statement PDFs to upload during the Use-Case Round tests:

- `UC1-Retail-Demand-Forecasting.pdf`
- `UC2-Customer-Support-Assistant.pdf`
- `UC3-Hospital-Appointment-Scheduling.pdf`
- `UC4-Campus-Energy-Dashboard.pdf`

---

## 2. Admin basics

Sign in at http://localhost:3000 with the admin account you created.

| # | Do this | Expected result |
|---|---|---|
| A1 | Sign in as admin. | You land on **Dashboard & Results**. The tabs are: Dashboard & Results, Candidates, Question Bank, Use Cases, Configuration. |
| A2 | Sign in with a wrong password 8 times, then with the right one. | After 8 failures the account is locked for 15 minutes. *(Optional. To unlock early, restart the portal with Ctrl+C and then `npm start`.)* |
| A3 | **Configuration:** change the organisation name and examination name, then click **Save Configuration**. | The new names appear in the header of the admin and login pages. |
| A4 | **Configuration:** set **Test Type = MCQ Test**, tick **Test is open** and **Registration is open**, then save. | The header badge shows **MCQ Test · Open**. |

---

## 3. Candidates: registration and approval

| # | Do this | Expected result |
|---|---|---|
| C1 | In the candidate browser, open http://localhost:3000, choose **Register**, and enter an email ID (e.g. `asha.verma@college.edu`), name and password. | Registration succeeds. After signing in the candidate sees **Registration Awaiting Approval**. |
| C2 | Admin: **Candidates** tab. | The candidate is listed under **Registrations Pending Approval**. |
| C3 | Click **Approve**. | Within about 5 seconds the candidate's page moves on by itself to the instructions page. |
| C4 | Register 2 more candidates, then click **Approve All**. | Both are approved. |
| C5 | Register one more and click **Reject**. | That candidate sees **Registration Not Approved**. |
| C6 | Admin: **Add Candidate**. Enter an email ID and name, leave the password blank, and click **Add Candidate**. | A generated password is shown. The candidate can sign in with it straight away, with no approval needed. |
| C7 | Admin: **Bulk Upload Candidates**. Paste a few lines like `asha.verma@college.edu, Asha Verma, Asha@2026` and click **Upload Candidates**. | All are created and their passwords are shown. |
| C8 | **Reset Password** on a candidate. | A new password is shown, and the old one stops working. |
| C9 | Sign in as the same candidate in two browsers. | Only the latest sign-in stays active. |

---

## 4. MCQ Test (proctored)

Make sure **Configuration → Test Type = MCQ Test** and **Test is open** is ticked.

### 4.1 Before the test starts

| # | Do this | Expected result |
|---|---|---|
| M1 | Sign in as an approved candidate. | The **General Instructions** page and the **System Compatibility Check** are shown. |
| M2 | Tick the agreement box without enabling any device. | **I am ready to begin** stays disabled. |
| M3 | Click **Enable Camera** and allow it. | A camera preview appears and the step turns green. |
| M4 | Click **Enable Microphone** and allow it, then speak. | The step turns green and the green level bar moves when you speak. |
| M5 | Click **Share Screen** and choose a **window** or **tab** instead of the entire screen. | It is refused with "You shared a window or tab…". |
| M6 | Click **Share Screen** again and choose **Entire screen**. | The step turns green. |
| M7 | If you have a second monitor connected, click **Check Display**. | It reports more than one display and blocks the start. Disconnect it to continue. |
| M8 | With every step green and the box ticked, click **I am ready to begin**. | The test opens in **full screen** with a timer, section tabs, a question palette, and your camera preview with a microphone level bar on the right. |

### 4.2 Taking the test

| # | Do this | Expected result |
|---|---|---|
| M9 | Answer a few questions using **Save & Next**, **Mark for Review & Next** and **Clear Response**. | The palette colours change to match the legend. |
| M10 | Reload the page (F5) and sign in again if asked. | This counts as **Warning 1** (reloading is a violation). After you re-enable the devices your answers and the remaining time are restored. |
| M11 | Admin: **Dashboard & Results**. | The candidate shows **In progress** with the time left and the warning count. **View Details** shows the proctoring log, webcam and screen snapshots, and the answers so far. |

### 4.3 Violations (maximum 3, then automatic submission)

Use a fresh candidate for this part. Every item below is **one warning**. A warning box appears each time. **On the 3rd warning the test is submitted automatically** and the candidate cannot take it again.

| # | Do this | Expected result |
|---|---|---|
| V1 | Switch to another tab or app (Alt+Tab or Ctrl+Tab), then come back. | **Warning 1 of 3.** One switch counts once, not twice. |
| V2 | Press **Ctrl+C**, right-click, or try to paste. | **Warning 2 of 3.** The copy or paste is blocked. |
| V3 | Press **Esc** to leave full screen. | The test is covered by a **Full-Screen Mode Required** box until you click **Return to Full Screen**. **Warning 3 of 3** follows and the test is **submitted automatically** with the message "Test Terminated: Violation Limit Reached". |

Try these on other fresh candidates. Each is also one warning, and the test stays blocked until the problem is fixed:

| # | Do this | Expected result |
|---|---|---|
| V4 | Turn off the camera: block it in the address bar (padlock icon → Camera → Block) or unplug the webcam. | **Webcam Not Detected** box plus a warning. Click **Enable Camera** to continue. |
| V5 | Turn off the microphone: block it in the address bar or unplug the headset. | **Microphone Not Detected** box plus a warning. Click **Enable Microphone** to continue. |
| V6 | Click **Stop sharing** on Chrome's screen-sharing bar. | **Screen Sharing Stopped** box plus a warning. Share the entire screen again to continue. |

### 4.4 Microphone monitoring

| # | Do this | Expected result |
|---|---|---|
| S1 | During the test, talk out loud for 2–3 seconds. | Nothing is shown to the candidate, and **no warning** is given. |
| S2 | Admin: **View Details** for that candidate. | The proctoring log shows **Speech / sound detected**, and **Audio Recordings** has a 10-second clip you can play. Another clip can be recorded at most every 30 seconds. |

### 4.5 Finishing and results

| # | Do this | Expected result |
|---|---|---|
| R1 | Click **Submit Test**, check the summary, and confirm. | The candidate sees **Test Submitted Successfully**. **The candidate never sees their score.** |
| R2 | Sign in again as that candidate. | **Test Already Submitted.** The test cannot be taken twice. |
| R3 | Admin: **Dashboard & Results**. | The score, section-wise scores, warnings and submit time are shown. **View Details** shows each answer against the correct one. |
| R4 | Click **Export Results (CSV)**. | A CSV file downloads and opens in Excel. |
| R5 | **Candidates → Allow Re-attempt** on a submitted candidate. | That candidate can take the test again from the start. |
| R6 | Admin: set **Configuration → Duration** to 2 minutes and save, then start a new candidate and wait. | When the timer reaches 0 the test is submitted automatically ("Time Over"). This also happens if the candidate closes the browser. |

### 4.6 Question bank, marking and timing

| # | Do this | Expected result |
|---|---|---|
| Q1 | **Question Bank → Add Question.** Fill in the question, 4 options, the correct answer and the marks, then save. | It appears in the list and in a new candidate's test. |
| Q2 | Edit a question's correct answer or marks after someone has submitted. | That candidate's score is recalculated automatically. |
| Q3 | **Sections:** add, rename, move up/down, and delete an empty section. | The changes appear in the candidate's section tabs. |
| Q4 | **Set Marks** on a section (e.g. +2 / −0.5). | Every question in that section uses the new marks. |
| Q5 | **Configuration → Separate timer for each section.** Set each section's time with **Set Time** under Question Bank → Sections, then start a new candidate. | The candidate sees one section at a time with its own timer. When it ends, or they click **Finish Section**, they move to the next section and cannot go back. |
| Q6 | Try to open the test with per-section timing on but a section without a time. | Saving is refused with a message listing the missing sections. |

---

## 5. Use-Case Round (not proctored)

### 5.1 Set it up (admin)

| # | Do this | Expected result |
|---|---|---|
| U1 | Make sure no candidate is in the middle of an MCQ test. Then go to **Configuration**, set **Test Type = Use-Case Round** and **Test is open**, and save. | It is refused with "Add at least one use case…" because no use cases exist yet. |
| U2 | **Use Cases → Add Use Case.** Give it a title and a short description, choose `sample-usecases/UC1-Retail-Demand-Forecasting.pdf`, and save. Repeat for UC2, UC3 and UC4. | 4 use cases are listed, each with its PDF. Clicking the PDF name opens it. |
| U3 | Try uploading a file that is not a PDF. | It is refused with "The file is not a valid PDF". |
| U4 | **Configuration:** set **Test Type = Use-Case Round**, **duration = 5 minutes**, **maximum marks = 100**, tick **Test is open**, and save. | The header shows **Use-Case Round · Open**. The MCQ options are hidden. |
| U5 | While a candidate is in the middle of a use-case attempt, try switching the test type back to MCQ. | It is refused: the test type can't be changed while candidates are taking a test. |

### 5.2 Candidate

| # | Do this | Expected result |
|---|---|---|
| U6 | Open the login page. | The instructions describe the use-case round and do not mention a webcam or screen sharing. |
| U7 | Sign in as an approved candidate. | **No** camera, microphone or screen check appears. You see the instructions with the minutes and maximum marks. |
| U8 | Tick the box and click **Start**. | One use case is shown with its **PDF inside the page** and a timer at the top. |
| U9 | Copy, paste, switch tabs, or reload the page. | Everything is allowed and there are no warnings. After a reload you get the **same** use case and the timer has kept running. |
| U10 | Type `github.com/abc`, without `https://`, and click **Submit Solution**. | It is refused and asks for a full link starting with `https://`. |
| U11 | Enter a full link (e.g. `https://github.com/test/solution`), click **Submit Solution**, and confirm. | **Solution Submitted Successfully.** |
| U12 | Sign in again as that candidate. | It shows the already-submitted link. There is no Start button and no way to submit again. Only one submission is allowed. |
| U13 | Start with 4–5 different candidates. | They get **different use cases at random**. Each candidate only ever sees their own PDF. |
| U14 | Start a candidate, type a link but don't submit, and let the 5 minutes run out. | The link in the box is submitted automatically when time ends. With an empty box, the attempt closes as "Time Over" with no link. |
| U15 | Start a candidate, close the browser, and wait past the deadline. | The admin sees the attempt closed with "Time over" and no link. |

### 5.3 Evaluation (admin)

| # | Do this | Expected result |
|---|---|---|
| U16 | **Dashboard & Results** (in Use-Case mode). | Each candidate is listed with their status, assigned use case, submit time and a clickable **solution link**, which opens in a new tab. |
| U17 | Enter marks (e.g. 75) and a remark, then click **Save**. | "Marks saved". The candidate shows **Evaluated**, and the average and highest marks update. |
| U18 | Try marks above the maximum (e.g. 150) or below 0. | It is refused. |
| U19 | **Close Attempt** on a candidate who is in progress. | Their attempt ends. They can't submit any more. |
| U20 | **Export Results (CSV).** | The CSV includes the email ID, name, use case, link, marks and remarks. |
| U21 | **Candidates → Allow Re-attempt.** | The candidate can start again with a new random use case. |
| U22 | **Use Cases:** try to delete a use case that has been assigned. | Delete is disabled or refused. |

---

## 6. Things that are not bugs

These are known limits of the portal, not bugs:

- **Only `localhost` or HTTPS:** opening the portal over a plain `http://` IP address from another device shows "Secure Connection Required".
- **Supported devices:** phones and tablets are blocked on purpose. Only the latest Chrome and Edge are supported; other browsers may not work fully.
- **What a web page can't do:**
  - It cannot see a phone on the desk or a second person in the room.
  - It cannot block Alt+Tab or the Windows key.
  - These actions are detected and recorded as warnings or snapshots instead.
- **Speech detection:** detected speech is logged with an audio clip but is **never** counted as a warning, so background noise cannot auto-submit someone's test.
- **Old pages after an update:** if a page looks outdated after a restart, press **Ctrl+Shift+R** to reload it.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `node` is not recognised | Install Node.js from https://nodejs.org, then **open a new terminal**. |
| `npm install` fails | Check your internet connection, then run it again. |
| An error mentioning `node:sqlite` | Your Node.js is too old. Install version 22.13 or newer. |
| `EADDRINUSE` / port 3000 already in use | Another program is using port 3000. Close it, or start the portal on another port: Windows Command Prompt `set PORT=3100&& npm start`, PowerShell `$env:PORT=3100; npm start`, Mac/Linux `PORT=3100 npm start`. Then open http://localhost:3100. |
| Camera, microphone or screen permission was denied by mistake | Click the padlock icon in the address bar, set Camera and Microphone to **Allow**, and reload. |
| Camera "in use by another app" | Close Zoom, Teams and any other app using the camera. |
| Forgot the admin password | Run `npm run create-admin -- admin NewPassword "Test Admin"` again. |
| Want to start completely fresh | See section 1.5. |

---

## 8. Reporting bugs

Report each issue in this format. Screenshots help a lot.

```
Test number:    e.g. V3
Browser:        e.g. Chrome 130 on Windows 11
Steps:          what you did, step by step
Expected:       what this guide says should happen
Actual:         what happened instead
Screenshot:     attached / file name
```

If the terminal running `npm start` shows an error at that moment, copy it into the report too.
