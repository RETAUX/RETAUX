const db = require('../db/database')

const HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
const CAPACITY_PER_HOUR = 10
const SEASON_START_MONTH = 6  // julio (0-indexed)
const SEASON_END_MONTH = 9    // octubre (0-indexed)

function isWeekday(date) {
  const day = date.getDay()
  return day >= 1 && day <= 5
}

function isInSeason(date) {
  const m = date.getMonth()
  return m >= SEASON_START_MONTH && m <= SEASON_END_MONTH
}

function dateString(date) {
  return date.toISOString().split('T')[0]
}

function getBookingsCount(dateStr, hour) {
  return db.get('appointments')
    .filter(a => a.date === dateStr && a.hour === hour && a.status !== 'cancelled')
    .size()
    .value()
}

function nextAvailableSlot(afterDate) {
  const start = new Date(afterDate)
  start.setDate(start.getDate() + 1)
  start.setHours(0, 0, 0, 0)

  for (let d = new Date(start); ; d.setDate(d.getDate() + 1)) {
    if (!isInSeason(d) && d.getFullYear() === start.getFullYear()) {
      if (d.getMonth() > SEASON_END_MONTH || d.getMonth() < SEASON_START_MONTH) {
        const nextYear = new Date(d.getFullYear() + 1, SEASON_START_MONTH, 1)
        d.setTime(nextYear.getTime())
      }
    }
    if (!isWeekday(d)) continue
    if (!isInSeason(d)) continue

    const dateStr = dateString(d)
    for (const hour of HOURS) {
      if (getBookingsCount(dateStr, hour) < CAPACITY_PER_HOUR) {
        return { date: dateStr, hour }
      }
    }
  }
}

function assignAppointment(userId, paymentDate) {
  const slot = nextAvailableSlot(paymentDate || new Date())
  const appointment = {
    id: require('uuid').v4(),
    userId,
    date: slot.date,
    hour: slot.hour,
    status: 'pending',
    createdAt: new Date().toISOString()
  }
  db.get('appointments').push(appointment).write()
  return appointment
}

function getAvailabilityCalendar(year, month) {
  const calendar = []
  const date = new Date(year, month, 1)

  while (date.getMonth() === month) {
    if (isWeekday(date) && isInSeason(date)) {
      const dateStr = dateString(date)
      const slots = HOURS.map(hour => ({
        hour,
        booked: getBookingsCount(dateStr, hour),
        available: CAPACITY_PER_HOUR - getBookingsCount(dateStr, hour)
      }))
      const totalBooked = slots.reduce((s, h) => s + h.booked, 0)
      const totalAvailable = slots.reduce((s, h) => s + h.available, 0)
      calendar.push({ date: dateStr, slots, totalBooked, totalAvailable })
    }
    date.setDate(date.getDate() + 1)
  }
  return calendar
}

module.exports = { assignAppointment, nextAvailableSlot, getAvailabilityCalendar }
