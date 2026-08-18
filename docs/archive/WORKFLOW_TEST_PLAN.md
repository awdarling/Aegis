# Aegis Email Workflow Test Plan

A top-to-bottom script for checking every email workflow. Run it in the **sandbox**, not on the real club.

## The two inboxes you'll send from
- **Manager actions** → send from **sandbox-manager@quriasolutions.com**
- **Employee actions** → send from **aegisscheduler@gmail.com** (this is the test employee "Shmubba Sploosh," a Lifeguard)
- **Send everything TO:** **sandbox@aegis.quriasolutions.com**

That keeps all of this off the live Watermark club and away from real employees.

## Before you start (one-time, ~10 min)
Two pieces of this aren't live yet — the manager-edits work and the emergency-coverage email work are sitting on their own branches. You need to merge and redeploy them first, or those sections will fail:
1. Merge `feat/manager-edits-and-inquiries` → wait for Railway to redeploy Aegis.
2. Merge `feat/emergency-coverage-email` → wait for Railway to redeploy Aegis.

Both are Aegis-only and reply-based, so there's no Homebase deploy and no special order to worry about. Everything else in this plan is already live.

## How to read each test
Each item gives you the exact words to send, who to send them from, and what a **pass** looks like. Check the box if it behaves as described.

---

## 1. General inquiries (just asking questions, no changes)

### Employee questions — send from aegisscheduler@gmail.com
- [ ] **"When do I work this week?"** → Expect: a list of Shmubba's upcoming shifts, days and times.
- [ ] **"What's my schedule for Monday?"** → Expect: just Monday's shift (or "you're not scheduled Monday").
- [ ] **"Who am I working with on Saturday?"** → Expect: coworker names and roles for shifts he shares — and crucially **no one's pay or personal availability** (that's private).
- [ ] **"How many hours am I scheduled next week?"** → Expect: a total hours number.

### Manager questions — send from sandbox-manager@quriasolutions.com
- [ ] **"Who's working Saturday?"** → Expect: the Saturday roster.
- [ ] **"Who's available Saturday afternoon?"** → Expect: employees free that window.
- [ ] **"How many lifeguards are on Friday night?"** → Expect: a count / list.
- [ ] **"Is anyone over 40 hours this week?"** → Expect: an overtime read (names or "no one").
- [ ] **"Who's scheduled the most hours this week?"** → Expect: ranked answer.

---

## 2. Time off

### Employee submits — from aegisscheduler@gmail.com
- [ ] **"I need July 20th and 21st off for a family trip."**
  → Expect: Aegis reads back the dates and asks you to confirm. Reply **"yes"**. Then the **manager** gets an email with **Approve / Deny** buttons.
- [ ] In the manager inbox, **click Approve** → Expect: Shmubba gets an email saying it was approved. (Run it again and click **Deny** to see the denial path.)
- [ ] **"What time off do I have coming up?"** (from Shmubba) → Expect: his pending/approved time off listed back.

---

## 3. Availability (the permanent weekly kind)

All of these are sent **from aegisscheduler@gmail.com** (the employee). Each one ends with the **manager** getting an Approve/Deny email — click the button to finish.

- [ ] **"I can't work Wednesdays anymore."**
  → Expect: since there's no availability on file, Aegis assumes "available all week **except** Wednesday" and asks you to confirm. Reply **"yes"** → manager gets Approve/Deny.
- [ ] **"I can only work mornings on Mondays."**
  → Expect: it understands "mornings" as open-to-noon (not a literal time you typed). Confirm → manager Approve/Deny.
- [ ] **"No Monday mornings."**
  → Expect: it trims just the morning off Monday and keeps the rest of the day.
- [ ] **"I can't work Mondays and Wednesdays."** *(this is the bug we just fixed)*
  → Expect: Monday and Wednesday turn **fully off** — no weird "9:15pm–9:15pm" sliver, and both days actually show as off in Homebase after approval.

---

## 4. Custom availability (temporary, with an end date)

- [ ] **"I can't work mornings until September 1st."** (from aegisscheduler@gmail.com)
  → Expect: the manager's email is framed as **temporary** — "Temporary availability through September 1" — with Approve/Deny. Approve it → it sets a date-limited override that expires on its own.

> Note: the "repeats every other week" rotating kind is **not built yet** (deferred). Only the "until a date" kind is ready to test.

---

## 5. Sending the schedule out

### From sandbox-manager@quriasolutions.com
- [ ] **"Send this week's schedule to all staff."** → Expect: the schedule emailed out to the sandbox employees (full names, roles, right colors).
- [ ] *(Optional, heavier)* **"Build next week's schedule."** → Expect: Aegis builds it. Skip if you just want to test the email side.

---

## 6. Manager edits by email (Aegis making real changes for you)

### From sandbox-manager@quriasolutions.com — each asks you to confirm before it writes
- [ ] **"Change Shmubba's role to Supervisor."** → Expect: Aegis confirms, you reply **"yes"**, it makes the change.
- [ ] **"Shmubba mentioned he can't work Fridays anymore — update his availability."**
  → Expect: this is the **manager changing an employee's availability** for them. Confirm → it writes the change. *(This is the one we built so you can do it in passing when an employee mentions it.)*
- [ ] **"Set the max weekly hours to 40."** → Expect: confirms, you say yes, it updates the policy.
- [ ] **"Add a lifeguard to Saturday at 5pm."** *(this should be politely refused)*
  → Expect: Aegis declines to edit the schedule by email and points you to do schedule changes in Homebase. **A refusal here is the correct, passing result** — we guarded schedule edits on purpose.

---

## 7. Emergency coverage (someone calls out)

### From sandbox-manager@quriasolutions.com
- [ ] **"Shmubba can't come in for his shift today, I need someone to cover."**
  → Expect: Aegis replies with a short list of candidates — qualified for the role, not already working that day, no time off, fewest hours first — each with contact info.
- [ ] Reply **"show me more"** → Expect: the next batch of candidates (no repeats).
- [ ] Reply with **a name** (or "you reach out to them") → Expect: Aegis emails that person: "Can you cover…? **Reply YES or NO**."
- [ ] From **that candidate's inbox, reply "YES"** → Expect: you (the manager) get told it's covered, and anyone else contacted is told it's filled.

> Two honest notes: (1) accepting marks the shift **covered and notifies everyone**, but it does **not** yet write the new assignment onto the schedule — that's a known to-do. (2) To test the "YES" step you need the candidate to be a test employee with a **real inbox you control**. Shmubba's inbox is the only real one, and he's the one calling out — so for this test, either call out a *different* employee and let Shmubba be the candidate, or point a second test employee's email at an inbox you own.

---

## 8. Shift swaps (between two employees)

This needs **two real inboxes** — one employee to start the swap, another to accept it. The built-in Test Guards use fake @example.com addresses that won't deliver, so set a second test employee's email to a real inbox before testing the accept step.

### From the employee starting it (aegisscheduler@gmail.com)
- [ ] **"I want to swap my Saturday shift — can someone else take it?"**
  → Expect: Aegis figures out which shift, finds eligible coworkers, and reaches out to them.
- [ ] From the **coworker's** inbox, reply **"Yes, I'll take it."** → Expect: that's recorded as an acceptance. (Try **"No"** from another to see the decline path.)
- [ ] The **manager** then gets an Approve/Deny step → approve it → Expect: the swap is applied and **both employees are notified**.

---

## 9. Re-running a time-off check + resolution guards

These cover TO-RERUN-1: re-checking a stale time-off recommendation, and the guards that stop two people double-acting on the same request. You'll touch both Homebase (the Time Off tab) and the manager email.

> Setup tip: the recommendation only goes "stale" when something changes the coverage picture *after* a request comes in. The easiest way to see it move is to have **two overlapping pending requests** for the same role/day, approve one, then re-check the other.

### 9a. Re-run check in Homebase (the Time Off tab)
- [ ] Open **Data → Time Off**, filter to **Pending**. Each pending request shows a **"Re-run check"** button next to Approve/Deny.
- [ ] Click **Re-run check** on a pending request → Expect: the button shows **"Re-checking…"** briefly, then a notice appears telling you what Aegis now recommends (e.g. *"Re-checked against everything currently approved — Aegis now recommends: Approve."* or *"…Don't approve (1 coverage gap if approved now)."*), and the recommendation badge refreshes to match.
- [ ] If there's no shift schedule set up for that role/day → Expect: *"…there's no shift schedule set up to measure coverage against, so the recommendation is unchanged."* (No crash, badge unchanged.)
- [ ] Click **Re-run check** again on the same request → Expect: it just re-checks again (the in-tab button is **not** single-use).

### 9b. Re-run check from the manager email
- [ ] Submit a time-off request (from aegisscheduler@gmail.com per §2) so the manager gets the Approve / Deny / **Re-run check** email card.
- [ ] In the manager inbox, click **Re-run check** on the card → Expect: the landing page returns **instantly** with *"On it — I'm re-checking this … and will reply in that request's email thread in a moment. Check your inbox."* (the work runs in the background — the page does not hang).
- [ ] Wait a moment, then check the inbox → Expect: Aegis **replies in the same email thread** with a refreshed action card showing the updated recommendation.
- [ ] Click the **same** email's "Re-run check" button a second time → Expect: it reports the link was **already used** (the email button is single-use; use Homebase or the new card to re-check again).

### 9c. Resolution + click-guards (no double-acting)
- [ ] Approve a request **in Homebase**, then go to the **email** for that same request and click **Approve** (or Deny) → Expect: the landing page tells you it was **already decided — and by whom and when** (e.g. *"This request was already approved by Carolyn on Jun 17 — nothing changed."*). Nothing changes.
- [ ] Do the reverse: approve from the **email**, then try **Re-run check** on that same request → Expect: *"This time-off request has already been decided — no re-check needed."*
- [ ] After a request is approved/denied by **any** channel, check **every** manager's email thread for that request → Expect: a **"✓ Resolved"** reply has been posted into each thread, and the action buttons in those emails no longer do anything.

### 9d. Branding spot-check (the landing pages)
- [ ] Click any Aegis email action button and look at the page → Expect: the **dark Quria** look — black header bar with the Aegis logo + wordmark and an orange underline, a colored status dot/heading (green for success, red for errors, orange for the confirm step).
- [ ] Trigger an **already-used** link (click any action button twice) → Expect: a **reassuring** message, not an alarming one: *"This link has already been used — your last action went through, so nothing was missed…"*

---

## What "all passing" unlocks
Once these are all green, the email side is proven and we move to:
1. **The employee + manager handout** — a one-pager telling staff and managers everything they can do by email and exactly how to phrase it (built straight from the prompts above).
2. **SMS** — porting the proven workflows to text (the reply-YES/NO design means coverage and swaps carry over cleanly).
3. **Final polish** on Aegis + Homebase (the roadmap items: writing coverage onto the schedule, the access-management page, etc.).
