/**
 * Appointment scheduling logic for RETAUX.
 *
 * Rules:
 * - Window: 1 July – 31 October of the current (or next) year
 * - Days: Monday – Friday only
 * - Slots: 07:00, 08:00, ..., 16:00 → 10 slots per day
 * - Capacity: 10 users per slot (1 hour block)
 *
 * A "slot" is identified by { date: 'YYYY-MM-DD', hour: 7..16 }
 */

const db = require('./database');

const SLOT_CAPACITY = 10;
const SLOT_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]; // 10 slots → 7am to 4pm start (up to 5pm end)

function isWeekday(date) {
  const d = date.getDay(); // 0=Sun, 6=Sat
  return d >= 1 && d <= 5;
}

function dateStr(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns { startDate, endDate } for the booking window of a given year.
 * If today is past Oct 30 of the current year, it wraps to the next year.
 */
function getWindowForYear(refDate) {
  const now = refDate || new Date();
  let year = now.getFullYear();
  const cutoff = new Date(year, 9, 31); // Oct 31
  if (now > cutoff) year += 1;

  const start = new Date(year, 6, 1);  // July 1
  const end   = new Date(year, 9, 31); // Oct 31
  return { start, end, year };
}

/**
 * Returns an array of all slot objects { date, hour } in the booking window,
 * ordered chronologically.
 */
function allSlots(refDate) {
  const { start, end } = getWindowForYear(refDate);
  const slots = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (isWeekday(cur)) {
      const d = dateStr(cur);
      for (const h of SLOT_HOURS) {
        slots.push({ date: d, hour: h });
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return slots;
}

/**
 * Returns the next available slot (with remaining capacity).
 * The slot must be at least the day AFTER refDate (payment date).
 * If no slot is available in the window, returns null.
 */
function nextAvailableSlot(refDate) {
  const slots = allSlots(refDate);
  const base = refDate || new Date();

  // Minimum date: the day after payment (not same day, not before)
  const minDate = new Date(base);
  minDate.setDate(minDate.getDate() + 1);
  const minDateStr = dateStr(minDate);

  for (const slot of slots) {
    if (slot.date < minDateStr) continue; // must be strictly after payment day
    const booked = db.get('appointments')
      .filter({ date: slot.date, hour: slot.hour })
      .size()
      .value();
    if (booked < SLOT_CAPACITY) return slot;
  }
  return null;
}

/**
 * Books a slot for a user. Returns the appointment record.
 * Throws if no slots are available.
 */
function bookNextSlot(userId, taxYear, refDate) {
  const slot = nextAvailableSlot(refDate);
  if (!slot) throw new Error('No hay turnos disponibles en el período de emisión.');

  const { genId } = require('./helpers');
  const appt = {
    id: genId(),
    userId,
    taxYear,
    date: slot.date,
    hour: slot.hour,
    status: 'pending',      // pending → confirmed → completed → cancelled
    estimatedRefund: null,  // filled by admin
    adminNotes: '',
    createdAt: new Date().toISOString()
  };

  db.get('appointments').push(appt).write();
  return appt;
}

/**
 * Formats a slot as a human-readable string in Australian English.
 * e.g. "Thursday 12 June 2025 at 9:00 AM"
 */
function formatSlot(date, hour) {
  const d = new Date(`${date}T00:00:00`);
  const dayName = d.toLocaleDateString('en-AU', { weekday: 'long' });
  const datePart = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour > 12 ? hour - 12 : hour;
  return `${dayName} ${datePart} at ${h12}:00 ${suffix}`;
}

/**
 * Returns slot capacity info for admin calendar view.
 * Returns array of { date, hour, booked, remaining }
 */
function slotSummary(refDate) {
  const slots = allSlots(refDate);
  return slots.map(s => {
    const booked = db.get('appointments')
      .filter({ date: s.date, hour: s.hour })
      .size()
      .value();
    return { ...s, booked, remaining: SLOT_CAPACITY - booked };
  });
}

/**
 * Returns available slots grouped by date for user selection.
 * Returns: { 'YYYY-MM-DD': [7, 9, 11, ...], ... }
 */
function availableDates(refDate, limitDays = 30) {
  const slots = allSlots(refDate);
  const base = refDate || new Date();
  const minDate = new Date(base);
  minDate.setDate(minDate.getDate() + 1);
  const minDateStr = dateStr(minDate);

  const result = {};
  let daysAdded = 0;
  let lastDate = null;

  for (const slot of slots) {
    if (slot.date < minDateStr) continue;
    const booked = db.get('appointments').filter({ date: slot.date, hour: slot.hour }).size().value();
    if (booked < SLOT_CAPACITY) {
      if (!result[slot.date]) {
        result[slot.date] = [];
        if (slot.date !== lastDate) { daysAdded++; lastDate = slot.date; }
      }
      result[slot.date].push(slot.hour);
    }
    if (daysAdded >= limitDays) break;
  }
  return result;
}

/**
 * Books a specific slot chosen by the user.
 */
function bookChosenSlot(userId, taxYear, date, hour) {
  const booked = db.get('appointments').filter({ date, hour }).size().value();
  if (booked >= SLOT_CAPACITY) throw new Error('Ese horario ya no tiene disponibilidad.');

  const { genId } = require('./helpers');
  const appt = {
    id: genId(), userId, taxYear,
    date, hour: Number(hour),
    status: 'confirmed',
    estimatedRefund: null,
    adminNotes: '',
    createdAt: new Date().toISOString()
  };
  db.get('appointments').push(appt).write();
  return appt;
}

module.exports = { nextAvailableSlot, bookNextSlot, bookChosenSlot, availableDates, formatSlot, slotSummary, getWindowForYear, SLOT_HOURS, SLOT_CAPACITY };
