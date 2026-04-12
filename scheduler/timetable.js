export const ND1_TIMETABLE = [
  {
    day: "Monday",
    lectures: [
      { subject: "Engineering Mathematics I", startTime: "08:00", endTime: "10:00", venue: "LT1" },
      { subject: "Engineering Chemistry", startTime: "10:00", endTime: "12:00", venue: "LT2" },
      { subject: "Introduction to Computing", startTime: "13:00", endTime: "15:00", venue: "CL1" },
      { subject: "Technical Drawing", startTime: "15:00", endTime: "17:00", venue: "TD Lab" },
    ],
  },
  {
    day: "Tuesday",
    lectures: [
      { subject: "Engineering Physics", startTime: "08:00", endTime: "10:00", venue: "LT3" },
      { subject: "Engineering Mathematics I", startTime: "10:00", endTime: "12:00", venue: "LT1" },
      { subject: "Communication Skills", startTime: "13:00", endTime: "15:00", venue: "LT4" },
    ],
  },
  {
    day: "Wednesday",
    lectures: [
      { subject: "Engineering Chemistry Lab", startTime: "08:00", endTime: "11:00", venue: "Chem Lab" },
      { subject: "Introduction to Computing Lab", startTime: "11:00", endTime: "13:00", venue: "CL1" },
      { subject: "Engineering Physics", startTime: "14:00", endTime: "16:00", venue: "LT3" },
    ],
  },
  {
    day: "Thursday",
    lectures: [
      { subject: "Engineering Mathematics I", startTime: "08:00", endTime: "10:00", venue: "LT1" },
      { subject: "Technical Drawing", startTime: "10:00", endTime: "12:00", venue: "TD Lab" },
      { subject: "Engineering Physics Lab", startTime: "13:00", endTime: "16:00", venue: "Phys Lab" },
    ],
  },
  {
    day: "Friday",
    lectures: [
      { subject: "Communication Skills", startTime: "08:00", endTime: "10:00", venue: "LT4" },
      { subject: "Engineering Chemistry", startTime: "10:00", endTime: "12:00", venue: "LT2" },
      { subject: "Introduction to Engineering", startTime: "13:00", endTime: "15:00", venue: "LT1" },
    ],
  },
  { day: "Saturday", lectures: [] },
  { day: "Sunday", lectures: [] },
];

export function getCurrentDay() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[new Date().getDay()];
}

export function getTodayTimetable() {
  const today = getCurrentDay();
  return ND1_TIMETABLE.find((d) => d.day === today) || ND1_TIMETABLE[0];
}

export function getYesterdayTimetable() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const yesterday = days[(new Date().getDay() + 6) % 7];
  return ND1_TIMETABLE.find((d) => d.day === yesterday) || ND1_TIMETABLE[0];
}

export function getLastLectureEndTime(dayEntry) {
  if (!dayEntry.lectures.length) return null;
  const sorted = [...dayEntry.lectures].sort((a, b) => a.endTime.localeCompare(b.endTime));
  return sorted[sorted.length - 1].endTime;
}
