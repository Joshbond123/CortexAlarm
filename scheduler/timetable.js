// ND1 Computer Science Timetable — 2nd Semester
export const ND1_TIMETABLE = [
  {
    day: "Monday",
    lectures: [
      { code: "COM 121", subject: "Programming Using C",         startTime: "08:00", endTime: "09:00" },
      { code: "GNS 102", subject: "Communication in English II", startTime: "09:00", endTime: "10:00" },
    ],
  },
  {
    day: "Tuesday",
    lectures: [
      { code: "COM 124", subject: "Data Structures & Algorithms", startTime: "11:00", endTime: "12:00" },
      { code: "MTH 121", subject: "Calculus I",                   startTime: "13:00", endTime: "14:00" },
    ],
  },
  {
    day: "Wednesday",
    lectures: [
      { code: "COM 123", subject: "Programming Using Java I", startTime: "08:00", endTime: "09:00" },
      { code: "EED 126", subject: "Entrepreneurship",         startTime: "10:00", endTime: "11:00" },
    ],
  },
  {
    day: "Thursday",
    lectures: [
      { code: "GNS 121", subject: "Citizenship Education II", startTime: "12:00", endTime: "13:00" },
      { code: "COM 125", subject: "System Analysis & Design",  startTime: "14:00", endTime: "15:00" },
    ],
  },
  {
    day: "Friday",
    lectures: [
      { code: "COM 126", subject: "PC Upgrade & Maintenance", startTime: "08:00", endTime: "09:00" },
    ],
  },
  { day: "Saturday", lectures: [] },
  { day: "Sunday",   lectures: [] },
];

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function getTodayTimetable(timezone = "Africa/Lagos") {
  const now = new Date();
  const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(now);
  return ND1_TIMETABLE.find((d) => d.day === dayName) || { day: dayName, lectures: [] };
}

export function getYesterdayTimetable(timezone = "Africa/Lagos") {
  const yesterday = new Date(Date.now() - 86400000);
  const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(yesterday);
  return ND1_TIMETABLE.find((d) => d.day === dayName) || { day: dayName, lectures: [] };
}

export function getLastLectureEndTime(dayData) {
  if (!dayData?.lectures?.length) return null;
  return [...dayData.lectures].sort((a, b) => a.endTime.localeCompare(b.endTime)).at(-1).endTime;
}

export function isWeekend(dayData) {
  return dayData?.day === "Saturday" || dayData?.day === "Sunday";
}

export function getAllCourseNames() {
  return [...new Set(
    ND1_TIMETABLE.flatMap((d) => d.lectures.map((l) => `${l.code} (${l.subject})`))
  )];
}
