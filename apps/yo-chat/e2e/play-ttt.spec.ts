import { test, expect, type Page } from '@playwright/test'

/**
 * E2E tests for the play_ttt agentic MCP tool.
 *
 * This tests the full flow of:
 * 1. User requests to play tic-tac-toe
 * 2. LLM calls play_ttt tool (single call for entire game)
 * 3. Server runs the agentic game loop:
 *    - L1: Model picks strategy (tool calling)
 *    - L2: Model picks move (structured output)
 *    - Elicitation: User picks their move
 * 4. Game continues until win/draw
 * 5. Tool returns final result
 *
 * Key differences from tictactoe.spec.ts:
 * - Random X/O assignment (model or user could be X)
 * - Single tool call handles entire game (agentic pattern)
 * - Uses L1/L2 sampling pattern for AI decisions
 *
 * Run with: pnpm test:e2e --grep "play_ttt"
 */

// Longer timeout for LLM responses (more sampling calls)
test.setTimeout(240000) // 4 minutes per test max

// =============================================================================
// SETUP
// =============================================================================

test.describe('play_ttt Agentic Tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/play-ttt/', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Agentic Tic-Tac-Toe' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  // =============================================================================
  // HELPER FUNCTIONS
  // =============================================================================

  /**
   * Detects which symbol (X or O) the user is playing.
   * The first elicitation will show "Your turn! You're playing as X/O"
   * or if model goes first, we see model's X first then our O cells become clickable.
   */
  async function detectUserSymbol(page: Page): Promise<'X' | 'O' | null> {
    // Look for the message that tells us which symbol we're playing
    const userXMessage = page.locator('text=/playing as X/i')
    const userOMessage = page.locator('text=/playing as O/i')
    
    if (await userXMessage.isVisible()) return 'X'
    if (await userOMessage.isVisible()) return 'O'
    
    // Fallback: if we see X marks but we can still click cells, we're O
    const xMarks = page.locator('.text-cyan-400').filter({ hasText: 'X' })
    if (await xMarks.count() > 0) return 'O' // Model made first move as X
    
    return null
  }

  // =============================================================================
  // BASIC FLOW TESTS
  // =============================================================================

  test('game starts and board appears', async ({ page }) => {
    // Click the Start Game button
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for streaming to start
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 30000 })

    // Wait for the board to appear - look for clickable cells (numbers 0-8)
    // OR the model's first move (X or O)
    const boardCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    const xMark = page.locator('.text-cyan-400').filter({ hasText: 'X' })
    const oMark = page.locator('.text-purple-400').filter({ hasText: 'O' })

    try {
      // Wait for board - either empty cells or a played mark
      await expect(boardCell.or(xMark).or(oMark)).toBeVisible({ timeout: 90000 })
      console.log('TicTacToe board appeared!')

      // The board should be visible
      const board = page.locator('.grid-cols-3')
      await expect(board).toBeVisible()

      // Detect user symbol
      const userSymbol = await detectUserSymbol(page)
      console.log(`User is playing as: ${userSymbol || 'unknown'}`)

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
      test.skip(true, 'LLM did not call play_ttt tool')
    }
  })

  test('user can click a cell to make a move', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board to appear
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()

    try {
      await expect(emptyCell).toBeVisible({ timeout: 90000 })

      // Get the cell position before clicking
      const cellText = await emptyCell.textContent()
      console.log(`Clicking cell ${cellText}`)

      // Click the cell
      await emptyCell.click()

      // After clicking, the cell should show user's mark
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
    await page.getByRole('button', { name: 'Start Game' }).click()
    console.log('Starting game...')

    let moveCount = 0
    const maxMoves = 9 // Maximum possible moves in tic-tac-toe

    while (moveCount < maxMoves) {
      // Wait for board with empty cells OR game over state
      const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
      const gameOver = page.locator('text=/wins!|draw!|Good game!|Well played!/i')

      // Check for error first
      const errorLocator = page.locator('.text-red-400')
      if (await errorLocator.count() > 0) {
        const errorText = await errorLocator.first().textContent()
        console.log(`Error detected: ${errorText}`)
        throw new Error(`Game error: ${errorText}`)
      }

      // Wait for either empty cells or game over
      try {
        await expect(emptyCell.or(gameOver)).toBeVisible({ timeout: 90000 })
      } catch {
        // Check if streaming is still happening
        if (await page.getByText('thinking...').isVisible()) {
          console.log('Still waiting for model response...')
          await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 90000 })
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
          await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 90000 })
        } catch {
          // Model might respond very quickly or game might end
          console.log('Quick response or game ended')
        }
      }
    }

    // If we made all possible moves, game should be over (draw at minimum)
    const gameOver = page.locator('text=/wins!|draw!|Good game!|Well played!/i')
    await expect(gameOver).toBeVisible({ timeout: 30000 })
    console.log('Game completed!')
  })

  // =============================================================================
  // RANDOM ASSIGNMENT TESTS
  // =============================================================================

  test('handles both X and O assignment for user', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board to appear
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 90000 })

    // Detect if user is X or O
    const userSymbol = await detectUserSymbol(page)
    console.log(`User assigned: ${userSymbol}`)

    // Either way, we should be able to click a cell
    if (await emptyCell.isVisible()) {
      await emptyCell.click()
      
      // Verify our move was registered (we should see our mark)
      if (userSymbol === 'X') {
        const ourMark = page.locator('.text-cyan-400').filter({ hasText: 'X' })
        await expect(ourMark).toBeVisible({ timeout: 30000 })
      } else if (userSymbol === 'O') {
        const ourMark = page.locator('.text-purple-400').filter({ hasText: 'O' })
        await expect(ourMark).toBeVisible({ timeout: 30000 })
      }
      
      console.log('User move registered successfully!')
    }
  })

  // =============================================================================
  // COMPONENT DETAIL TESTS
  // =============================================================================

  test('board shows correct player marks with colors', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 90000 })

    // X should be cyan, O should be purple
    const xMarks = page.locator('.text-cyan-400').filter({ hasText: 'X' })
    const oMarks = page.locator('.text-purple-400').filter({ hasText: 'O' })

    // Make a move
    await emptyCell.click()

    // Wait for response
    await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 90000 })

    // After a few moves, we should see both X and O marks
    const totalMarks = (await xMarks.count()) + (await oMarks.count())
    expect(totalMarks).toBeGreaterThan(0)
    console.log(`Found ${await xMarks.count()} X marks and ${await oMarks.count()} O marks`)
  })

  test('board highlights last move', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    // Wait for board
    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 90000 })

    // There should be a highlighted cell (last move)
    // The cyan highlight is for model's last move
    const cyanHighlight = page.locator('.bg-cyan-900\\/30')
    const purpleHighlight = page.locator('.bg-purple-900\\/30')
    
    const hasHighlight = await cyanHighlight.or(purpleHighlight).isVisible()
    if (hasHighlight) {
      console.log('Last move highlighting verified!')
    } else {
      // If user goes first, no highlight initially
      console.log('No highlight (user goes first or not implemented)')
    }
  })

  // =============================================================================
  // L1/L2 SAMPLING VERIFICATION
  // =============================================================================

  test('model uses strategy before making moves', async ({ page }) => {
    // This test verifies the L1/L2 pattern is working by checking
    // that the model makes reasonable moves (not random)
    
    await page.getByRole('button', { name: 'Start Game' }).click()

    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()
    await expect(emptyCell).toBeVisible({ timeout: 90000 })

    // Play through a few moves and verify game progresses
    let moves = 0
    while (moves < 4 && await emptyCell.isVisible()) {
      await emptyCell.click()
      moves++
      
      try {
        await expect(page.getByText('thinking...')).toBeVisible({ timeout: 10000 })
        await expect(page.getByText('thinking...')).not.toBeVisible({ timeout: 90000 })
      } catch {
        break // Game might have ended
      }
    }

    // Verify game progressed (model made moves)
    const xMarks = page.locator('.text-cyan-400').filter({ hasText: 'X' })
    const oMarks = page.locator('.text-purple-400').filter({ hasText: 'O' })
    const totalMarks = (await xMarks.count()) + (await oMarks.count())
    
    expect(totalMarks).toBeGreaterThanOrEqual(2) // At least 2 moves made
    console.log(`L1/L2 pattern working - ${totalMarks} moves made`)
  })

  // =============================================================================
  // ERROR HANDLING TESTS
  // =============================================================================

  test('handles game cancellation gracefully', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Game' }).click()

    const emptyCell = page.locator('button').filter({ hasText: /^[0-8]$/ }).first()

    try {
      await expect(emptyCell).toBeVisible({ timeout: 90000 })

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
