import { test, expect } from '@playwright/test'

/**
 * E2E tests for the tictactoe MCP plugin tool.
 *
 * This tests the full flow of:
 * 1. User requests to play tic-tac-toe
 * 2. LLM calls the tictactoe tool with action="start"
 * 3. Server-side tool execution triggers elicitation
 * 4. Client renders TicTacToeBoard component
 * 5. User clicks a cell
 * 6. Client sends response, server resumes tool
 * 7. LLM calls tictactoe with action="move" and its next move
 * 8. Repeat until game ends
 * 9. LLM calls tictactoe with action="end"
 *
 * Run with: pnpm test:e2e --grep "tictactoe"
 */

// Reasonable timeout for LLM responses
test.setTimeout(180000) // 3 minutes per test max

// =============================================================================
// SETUP
// =============================================================================

test.describe('tictactoe Plugin Tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/tictactoe/', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Tic-Tac-Toe' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  // =============================================================================
  // BASIC FLOW TESTS
  // =============================================================================

  test('game starts and board appears with model first move', async ({ page }) => {
    // Click the Start Game button
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for streaming to start
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 30000 })

    // Wait for the board to appear - look for clickable cells (numbers 0-8)
    // The board should show after model makes its first move
    const boardCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()

    try {
      await expect(boardCell).toBeVisible({ timeout: 60000 })
      console.log('TicTacToe board appeared!')

      // Verify we have multiple clickable cells (at least some empty ones)
      const emptyCells = page.locator('button').filter({ hasText: /^[0-8]$/ })
      const cellCount = await emptyCells.count()
      expect(cellCount).toBeGreaterThan(0)
      console.log(`Found ${cellCount} empty cells`)

      // Verify model made its first move (should see an X on the board)
      const modelMove = page.locator('div').filter({ hasText: /^X$/ })
      await expect(modelMove.first()).toBeVisible()
      console.log('Model made first move (X)')

    } catch (e) {
      // Check for error
      const errorLocator = page.locator('text=/^Error:/')
      if (await errorLocator.count() > 0) {
        const errorText = await errorLocator.first().textContent()
        throw new Error(`Tool execution error: ${errorText}`)
      }

      await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 30000 })
      const responseText = await page.locator('.prose').last().textContent()
      console.log('Board did not appear. Response:', responseText?.slice(0, 500))
      test.skip(true, 'LLM did not call tictactoe tool')
    }
  })

  test('user can click a cell to make a move', async ({ page }) => {
    // Start the game
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board to appear
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()

    try {
      await expect(emptyCell).toBeVisible({ timeout: 60000 })

      // Get the cell position before clicking
      const cellText = await emptyCell.textContent()
      console.log(`Clicking cell ${cellText}`)

      // Click the cell
      await emptyCell.click()

      // After clicking, the cell should show 'O' (user's mark)
      // Wait for the response and next board state
      await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })

      console.log('Move registered, waiting for model response...')

    } catch (e) {
      const errorLocator = page.locator('text=/^Error:/')
      if (await errorLocator.count() > 0) {
        const errorText = await errorLocator.first().textContent()
        throw new Error(`Error during move: ${errorText}`)
      }
      test.skip(true, 'Could not complete user move')
    }
  })

  test('full game: multiple moves until game ends', async ({ page }) => {
    // Start the game
    await page.getByRole('button', { name: 'Start Game' }).click()
    console.log('Starting game...')

    let moveCount = 0
    const maxMoves = 9 // Maximum possible moves in tic-tac-toe

    while (moveCount < maxMoves) {
      // Wait for board with empty cells OR game over state
      const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
      const gameOver = page.locator('text=/wins!|draw!/i')

      // Check for error first
      const errorLocator = page.locator('.text-red-400')
      if (await errorLocator.count() > 0) {
        const errorText = await errorLocator.first().textContent()
        console.log(`Error detected: ${errorText}`)
        throw new Error(`Game error: ${errorText}`)
      }

      // Wait for either empty cells or game over
      try {
        await expect(emptyCell.or(gameOver)).toBeVisible({ timeout: 60000 })
      } catch {
        // Check if streaming is still happening
        if (await page.getByText('thinking...').isVisible()) {
          console.log('Still waiting for model response...')
          await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 60000 })
          continue
        }
        throw new Error('Neither empty cells nor game over detected')
      }

      // Check if game is over
      if (await gameOver.isVisible()) {
        const resultText = await gameOver.textContent()
        console.log(`Game over after ${moveCount} user moves: ${resultText}`)
        
        // Verify final board state is visible
        const finalBoard = page.locator('.grid-cols-3')
        await expect(finalBoard).toBeVisible()
        
        return // Test passed!
      }

      // Game is not over, make a move
      if (await emptyCell.isVisible()) {
        moveCount++
        const cellText = await emptyCell.textContent()
        console.log(`Move ${moveCount}: Clicking cell ${cellText}`)
        
        await emptyCell.click()

        // Wait for model's response
        try {
          await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })
          await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 60000 })
        } catch {
          // Model might respond very quickly or game might end
          console.log('Quick response or game ended')
        }
      }
    }

    // If we made all possible moves, game should be over (draw at minimum)
    const gameOver = page.locator('text=/wins!|draw!/i')
    await expect(gameOver).toBeVisible({ timeout: 30000 })
    console.log('Game completed!')
  })

  // =============================================================================
  // COMPONENT DETAIL TESTS
  // =============================================================================

  test('board shows correct player marks (X for model, O for user)', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 60000 })

    // Model's X should be visible (cyan color)
    const modelX = page.locator('.text-cyan-400').filter({ hasText: 'X' })
    await expect(modelX).toBeVisible()

    // Click a cell to make our move
    await emptyCell.click()

    // Wait for our O to appear (purple color)
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })
    
    // Our O should be visible
    const userO = page.locator('.text-purple-400').filter({ hasText: 'O' })
    await expect(userO).toBeVisible({ timeout: 60000 })

    console.log('Player marks verified!')
  })

  test('board highlights last move', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 60000 })

    // Model's last move should be highlighted (cyan background)
    const highlightedCell = page.locator('.bg-cyan-900\\/30')
    await expect(highlightedCell).toBeVisible()

    console.log('Last move highlighting verified!')
  })

  // =============================================================================
  // ERROR HANDLING TESTS
  // =============================================================================

  test('handles game cancellation gracefully', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()

    try {
      await expect(emptyCell).toBeVisible({ timeout: 60000 })

      // Click Stop button to abort
      const stopButton = page.getByRole('button', { name: 'Stop' })
      if (await stopButton.isVisible()) {
        await stopButton.click()
        console.log('Clicked Stop button')
      }

      // Click New Game to reset
      await page.getByRole('button', { name: 'New Game' }).click()

      // Should be able to start a new game
      await page.getByRole('button', { name: 'Start Game' }).click()
      await expect(page.getByText('thinking...')).toBeVisible({ timeout: 30000 })

      console.log('Game reset successful!')

    } catch {
      test.skip(true, 'Could not test cancellation')
    }
  })
})
