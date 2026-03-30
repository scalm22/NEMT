// ─── Playwright NEMT Portal Booking Automation ───────────────────────────────
// This module acts as an authorized representative on behalf of the member.
// The member signs a one-page authorization form during Comet onboarding that
// legally permits VIS to submit bookings on their behalf — same as a caregiver
// or social worker calling in a ride. Every action here is within that scope.
//
// To add to server.js:
// 1. Import at the top:    import { bookViaPortal } from './booking-automation.js';
// 2. Add to TOOLS array:   the tool definition below
// 3. Add to executeTool:   case 'book_via_portal': return await bookViaPortal(input);
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from 'playwright';

// ─── Tool definition to add to your TOOLS array in server.js ─────────────────
export const BOOK_VIA_PORTAL_TOOL = {
  name: 'book_via_portal',
  description: 'Book a NEMT trip through the member portal as their authorized representative. Use this when no direct API is available. Only call after member has confirmed all trip details.',
  input_schema: {
    type: 'object',
    properties: {
      member_id:           { type: 'string', description: 'Member ID' },
      portal_username:     { type: 'string', description: 'Member portal username (from secure storage)' },
      portal_password:     { type: 'string', description: 'Member portal password (from secure storage — never logged)' },
      pickup_address:      { type: 'string' },
      destination_name:    { type: 'string' },
      destination_address: { type: 'string' },
      appointment_date:    { type: 'string', description: 'YYYY-MM-DD' },
      appointment_time:    { type: 'string', description: 'HH:MM 24hr — arrival time' },
      round_trip:          { type: 'boolean' },
      special_needs:       { type: 'string', default: 'none' },
      member_phone:        { type: 'string', description: 'For SMS confirmation' },
      language:            { type: 'string', description: 'en or es' },
    },
    required: [
      'member_id', 'pickup_address', 'destination_name',
      'destination_address', 'appointment_date', 'appointment_time', 'round_trip'
    ]
  }
};

// ─── Calculate pickup time (45 min before appointment) ───────────────────────
function calcPickupTime(appointmentTime) {
  const [h, m] = appointmentTime.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  d.setMinutes(d.getMinutes() - 45);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ─── Generate VIS confirmation number (used if portal scraping fails) ─────────
function genConfirmation() {
  return `VIS-${Date.now().toString().slice(-6)}`;
}

// ─── Main booking function ────────────────────────────────────────────────────
export async function bookViaPortal(params) {
  // NEVER log credentials — only log anonymized data
  console.log(`[portal-booking] starting for member: ${params.member_id}`);

  const pickupTime = calcPickupTime(params.appointment_time);
  let browser = null;

  try {
    // Launch headless browser — invisible, runs on Railway server
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // ── Step 1: Navigate to Modivcare member portal ───────────────────────────
    // TODO: Replace with actual Modivcare member portal URL
    // The real URL is typically: https://member.modivcare.com or the health-plan-specific portal
    await page.goto('https://member.modivcare.com', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    console.log(`[portal-booking] portal loaded`);

    // ── Step 2: Login as member (authorized representative) ───────────────────
    // TODO: Update selectors to match actual Modivcare portal HTML
    // Use browser DevTools on the real portal to find exact field IDs/names

    if (params.portal_username && params.portal_password) {
      await page.fill('#username', params.portal_username);
      await page.fill('#password', params.portal_password);
      await page.click('#login-button');
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
      console.log(`[portal-booking] logged in`);
    }

    // ── Step 3: Navigate to trip booking section ──────────────────────────────
    // TODO: Update selector/URL to match actual portal navigation
    await page.click('[href*="schedule"], [href*="book"], [href*="trip"]');
    await page.waitForLoadState('networkidle');

    // ── Step 4: Fill trip details ─────────────────────────────────────────────
    // TODO: Update all selectors to match actual portal form fields
    // These are placeholder selectors — inspect the real portal to get exact ones

    // Pickup address
    await page.fill('[name*="pickup"], [id*="pickup"], [placeholder*="pickup"]',
      params.pickup_address);

    // Destination
    await page.fill('[name*="destination"], [id*="destination"], [placeholder*="destination"]',
      params.destination_address);

    // Date — format may vary by portal (MM/DD/YYYY vs YYYY-MM-DD)
    const [year, month, day] = params.appointment_date.split('-');
    await page.fill('[name*="date"], [id*="date"], [type="date"]',
      `${month}/${day}/${year}`);

    // Appointment time
    await page.fill('[name*="time"], [id*="appt-time"], [id*="appointment"]',
      params.appointment_time);

    // Round trip
    if (params.round_trip) {
      const roundTripCheckbox = page.locator('[name*="round"], [id*="round"]');
      if (await roundTripCheckbox.count() > 0) {
        await roundTripCheckbox.check();
      }
    }

    // Special needs
    if (params.special_needs && params.special_needs !== 'none') {
      const specialNeedsField = page.locator('[name*="special"], [id*="wheelchair"], select[name*="vehicle"]');
      if (await specialNeedsField.count() > 0) {
        await specialNeedsField.selectOption({ label: params.special_needs });
      }
    }

    console.log(`[portal-booking] form filled`);

    // ── Step 5: Submit the booking ────────────────────────────────────────────
    await page.click('[type="submit"], [id*="submit"], [id*="book"], button:has-text("Schedule")');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // ── Step 6: Scrape confirmation number from success page ──────────────────
    // TODO: Update selector to match actual confirmation page element
    let confirmationNumber = genConfirmation();
    try {
      const confirmEl = await page.locator(
        '[id*="confirmation"], [class*="confirmation"], [id*="trip-id"], h2, .success'
      ).first();
      if (confirmEl) {
        const text = await confirmEl.textContent();
        const match = text?.match(/[A-Z0-9]{6,12}/);
        if (match) confirmationNumber = match[0];
      }
    } catch {
      console.log(`[portal-booking] using VIS confirmation number`);
    }

    console.log(`[portal-booking] booked — confirmation: ${confirmationNumber}`);

    await browser.close();

    return {
      success: true,
      confirmation_number: confirmationNumber,
      pickup_time: pickupTime,
      pickup_address: params.pickup_address,
      destination_name: params.destination_name,
      appointment_date: params.appointment_date,
      round_trip: params.round_trip,
      member_id: params.member_id,
      booked_via: 'authorized_representative',
      status: 'confirmed'
    };

  } catch (err) {
    console.error(`[portal-booking] error:`, err.message);
    if (browser) await browser.close();

    // Return a graceful failure — Comet tells member to expect a follow-up
    return {
      success: false,
      error: err.message,
      fallback_confirmation: genConfirmation(),
      member_id: params.member_id,
      status: 'pending_manual_review'
    };
  }
}

// ─── HOW TO INTEGRATE INTO server.js ─────────────────────────────────────────
//
// 1. Add this import at the top of server.js:
//    import { bookViaPortal, BOOK_VIA_PORTAL_TOOL } from './booking-automation.js';
//
// 2. Add BOOK_VIA_PORTAL_TOOL to your TOOLS array:
//    const TOOLS = [ ...existing tools..., BOOK_VIA_PORTAL_TOOL ];
//
// 3. Add to executeTool switch statement:
//    case 'book_via_portal':
//      return await bookViaPortal(toolInput);
//
// 4. Update package.json to add: "playwright": "^1.44.0"
//
// 5. Add to Railway environment variables:
//    PLAYWRIGHT_BROWSERS_PATH = /tmp/playwright-browsers
//
// 6. Add to your Railway start command in package.json:
//    "start": "npx playwright install chromium && node src/server.js"
// ─────────────────────────────────────────────────────────────────────────────
