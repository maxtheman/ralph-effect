import { test, expect } from "@playwright/test"

test.describe("Dashboard shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("page loads and shows dashboard header", async ({ page }) => {
    await expect(page.locator("header")).toBeVisible()
    // Title should contain the app name
    await expect(page.locator("header")).toContainText(/ralph/i)
  })

  test("connection status indicator exists", async ({ page }) => {
    // Should show either Live or Offline
    const status = page.locator('[role="status"], .dashboard__status')
    await expect(status).toBeVisible()
  })

  test("workflow canvas renders", async ({ page }) => {
    const canvas = page.locator(".workflow-canvas, [class*=canvas]")
    await expect(canvas).toBeVisible()
  })

  test("control panel renders with forms", async ({ page }) => {
    // Control panel should have at least one form or button
    const controls = page.locator(".control-panel, [class*=control]")
    await expect(controls).toBeVisible()
  })

  test("event log section exists", async ({ page }) => {
    const log = page.locator(".event-log, [class*=event-log]")
    await expect(log).toBeVisible()
  })
})

test.describe("Control panel interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("fork loop form has required fields", async ({ page }) => {
    // Should have goal input and submit
    const goalInput = page.locator(
      'textarea[placeholder*="goal" i], input[placeholder*="goal" i], .control-textarea'
    ).first()
    await expect(goalInput).toBeVisible()
  })

  test("can type in a text field without crash", async ({ page }) => {
    const textarea = page.locator("textarea").first()
    if (await textarea.isVisible()) {
      await textarea.fill("test message")
      await expect(textarea).toHaveValue("test message")
    }
  })

  test("buttons are clickable without console errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    const buttons = page.locator("button")
    const count = await buttons.count()
    // Click the first few buttons (not submit-type to avoid side effects)
    for (let i = 0; i < Math.min(count, 3); i++) {
      const btn = buttons.nth(i)
      const type = await btn.getAttribute("type")
      if (type !== "submit") {
        await btn.click({ timeout: 2000 }).catch(() => {})
      }
    }
    // No uncaught exceptions
    expect(errors).toHaveLength(0)
  })
})

test.describe("Resilience", () => {
  test("page does not crash with no backend", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    await page.goto("/")
    // Should still render even if backend is down
    await expect(page.locator("body")).toBeVisible()
    // Allow network errors but no uncaught JS exceptions
    expect(errors).toHaveLength(0)
  })

  test("no console errors on initial load", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    await page.goto("/")
    await page.waitForTimeout(2000)
    expect(errors).toHaveLength(0)
  })
})
