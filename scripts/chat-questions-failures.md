# Coordinator questions in the chat: failure modes (recorded before implementation)

Verify through an isolated host, fake model, browser. No real models, CI.

- Q1 Question still appears in the sidebar "Needs you" card (#letter) instead of the transcript.
- Q2 Question card is not after the latest message (above older messages, or hidden behind the live reply / composer).
- Q3 Card renders in the wrong chat (question asked by chat B shows in Main), or a question for another chat is invisible with no pointer to it.
- Q4 Choice buttons do not answer, or answer a different choice than clicked, or double-click sends twice (busy guard).
- Q5 Free-text field is hidden behind a "different answer" button; Enter does not send; Shift+Enter sends instead of newline; empty/whitespace answer is sent.
- Q6 Typing a draft is lost by a poll re-render, focus is stolen, or the draft leaks to another question/project.
- Q7 Retained draft and old UUID-only draft adoption no longer work.
- Q8 After answering, the card vanishes with no trace instead of a compact "Answered: <choice>" record in place; or the record moves to the end / reappears as pending.
- Q9 Markdown in the question body is injected unescaped (XSS) or title is duplicated in the description.
- Q10 Composer is hijacked: a pending question blocks normal messages, or no hint points the owner to the question.
- Q11 Sidebar loses operation approvals, or shows an empty "Needs you" card when only questions are pending, or keeps the card when nothing is pending.
- Q12 Tab badge (#needs-count) stops counting questions.
- Q13 Multiple questions do not stack in order, or answering one answers another.
- Q14 Cards stay interactive while another action is in flight; answering with an unchanged inbox after a reload fails.
- Q15 Light or dark theme: unreadable card/buttons (contrast), overflow at 420 px.
- Q16 Keys 1-9 pick a choice while typing in a textarea (must only act outside inputs).
- Q17 Existing E2Es driving #letter silently pass without verifying the answer path.
