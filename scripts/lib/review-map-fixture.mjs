export function reviewSteps() {
  return [
    {
      title: "Calendar boundaries",
      why: "A weekday calculation changes capacity estimates for every region.",
      risk: "high",
      files: ["calendar.js", "src/workdays.js"],
      checks: ["Check a weekend and a public holiday."],
      notes: [{ path: "calendar.js", side: "RIGHT", line: 1, text: "Compare this constant with the regional schedule." }],
    },
    {
      title: "Documentation and lockfile",
      why: "Confirm the examples match the implementation.",
      risk: "low",
      files: ["docs/calendar.md", "package-lock.json"],
      checks: ["Read the calendar example."],
      notes: [],
    },
  ];
}
