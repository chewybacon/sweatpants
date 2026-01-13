
import { test, expect } from '@playwright/test'

test.describe('play_ttt Multiple Games', () => {
  test.setTimeout(120000)
  test('can play two games in sequence without error', async ({ page }) => {
    // 1. Navigate to the page
    await page.goto('/chat/play-ttt/', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Agentic Tic-Tac-Toe' })).toBeVisible()

    // 2. Start the first game
    await page.getByRole('button', { name: 'Start Game' }).click()
    
    // Wait for the game to start (board visible)
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 30000 })
    
    // Play one move to ensure it's active
    await emptyCell.click()
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 30000 })

    // 3. Cancel/End the first game to prepare for the second
    // The current UI might not have a "Stop" button that cleanly ends the tool call logic on the server 
    // without using the "New Game" button which resets the chat.
    // However, the user said "twice in one chat", implying the chat history is preserved.
    // So we should try to trigger the tool again in the SAME chat session.
    
    // We can stop the current generation if it's streaming, or just ask for a new game.
    // If the tool is still running (waiting for user input), we might need to cancel it first.
    // The "Stop" button in the input area aborts the stream.
    
    // Let's try to ask for a new game directly.
    const input = page.locator('input[type="text"]')
    
    // If the game is still "running" (waiting for input), we might need to "finish" it or cancel it.
    // The `play_ttt` tool loop handles cancellation if the user declines.
    // But here we want to simulate what the user does. 
    // If the user says "play again", the previous tool call might still be technically "active" if it was waiting for input?
    // Actually, if the tool is waiting for `elicit`, the server is suspended.
    // Sending a new message usually requires the previous turn to be "done" or we need to cancel it.
    
    // Let's assume we play to completion or we cancel.
    // To be safe and fast, let's try to Cancel the first game using the "Stop" button if available, 
    // OR just send a message if the input is enabled.
    
    // Wait for input to be enabled (meaning the bot isn't streaming)
    await expect(input).not.toBeDisabled()
    
    // Send "Play again"
    await input.fill('Play again')
    await page.keyboard.press('Enter')
    
    // 4. Verify the second game starts
    // We expect a NEW board to appear.
    // The previous board should still be in the history.
    
    // We need to wait for the SECOND "thinking..." and then a NEW board.
    // We can check for a new "Move #1" or just that we can see a board again.
    
    // If it breaks, we expect an error message.
    
    // Wait for response
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 30000 })
    
    // Check for error
    const errorLocator = page.locator('.text-red-400').filter({ hasText: /Error/ })
    if (await errorLocator.count() > 0) {
        const text = await errorLocator.first().textContent()
        throw new Error(`Second game failed with error: ${text}`)
    }
    
    // Wait for board
    // We need to distinguish the new board from the old one.
    // The old one is likely scrolled up.
    // The new one should be at the bottom.
    // Actually, checking for 'thinking...' disappearing and no error is a good start.
    
    await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 60000 })
    
    // Check again for error after thinking stops
    if (await errorLocator.count() > 0) {
        const text = await errorLocator.first().textContent()
        throw new Error(`Second game failed with error: ${text}`)
    }
    
    // Verify we can interact with the new board (click a cell)
    // We need to make sure we are clicking a cell from the NEW game.
    // The "last" grid-cols-3 is probably the new one.
    const boards = page.locator('.grid-cols-3')
    const lastBoard = boards.last()
    
    const newGameCell = lastBoard.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(newGameCell).toBeVisible({ timeout: 10000 })
    await newGameCell.click()
    
    console.log('Second game started and move made successfully')
  })
})
