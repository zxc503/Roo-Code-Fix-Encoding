import delay from "delay"
import fs from "fs/promises"
import path from "path"

import { getReadablePath } from "../../utils/path"
import { readFileWithEncodingDetection } from "../../utils/encoding"
import { Task } from "../task/Task"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { insertGroups } from "../diff/insert-groups"
import { DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"

export async function insertContentTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const relPath: string | undefined = block.params.path
	const line: string | undefined = block.params.line
	const content: string | undefined = block.params.content

	const sharedMessageProps: ClineSayTool = {
		tool: "insertContent",
		path: getReadablePath(cline.cwd, removeClosingTag("path", relPath)),
		diff: content,
		lineNumber: line ? parseInt(line, 10) : undefined,
	}

	try {
		if (block.partial) {
			await cline.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
			return
		}

		// Validate required parameters
		if (!relPath) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("insert_content")
			pushToolResult(await cline.sayAndCreateMissingParamError("insert_content", "path"))
			return
		}

		if (!line) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("insert_content")
			pushToolResult(await cline.sayAndCreateMissingParamError("insert_content", "line"))
			return
		}

		if (content === undefined) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("insert_content")
			pushToolResult(await cline.sayAndCreateMissingParamError("insert_content", "content"))
			return
		}

		const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await cline.say("rooignore_error", relPath)
			pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))
			return
		}

		// Check if file is write-protected
		const isWriteProtected = cline.rooProtectedController?.isWriteProtected(relPath) || false

		const absolutePath = path.resolve(cline.cwd, relPath)
		const lineNumber = parseInt(line, 10)
		if (isNaN(lineNumber) || lineNumber < 0) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("insert_content")
			pushToolResult(formatResponse.toolError("Invalid line number. Must be a non-negative integer."))
			return
		}

		const fileExists = await fileExistsAtPath(absolutePath)
		let fileContent: string = ""
		if (!fileExists) {
			if (lineNumber > 1) {
				cline.consecutiveMistakeCount++
				cline.recordToolError("insert_content")
				const formattedError = `Cannot insert content at line ${lineNumber} into a non-existent file. For new files, 'line' must be 0 (to append) or 1 (to insert at the beginning).`
				await cline.say("error", formattedError)
				pushToolResult(formattedError)
				return
			}
		} else {
			fileContent = await readFileWithEncodingDetection(absolutePath)
		}

		cline.consecutiveMistakeCount = 0

		cline.diffViewProvider.editType = fileExists ? "modify" : "create"
		cline.diffViewProvider.originalContent = fileContent
		const lines = fileExists ? fileContent.split("\n") : []

		const updatedContent = insertGroups(lines, [
			{
				index: lineNumber - 1,
				elements: content.split("\n"),
			},
		]).join("\n")

		// Check if preventFocusDisruption experiment is enabled
		const provider = cline.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		// For consistency with writeToFileTool, handle new files differently
		let diff: string | undefined
		let approvalContent: string | undefined

		if (fileExists) {
			// For existing files, generate diff and check for changes
			diff = formatResponse.createPrettyPatch(relPath, fileContent, updatedContent)
			if (!diff) {
				pushToolResult(`No changes needed for '${relPath}'`)
				return
			}
			approvalContent = undefined
		} else {
			// For new files, skip diff generation and provide full content
			diff = undefined
			approvalContent = updatedContent
		}

		// Prepare the approval message (same for both flows)
		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			diff,
			content: approvalContent,
			lineNumber: lineNumber,
			isProtected: isWriteProtected,
		} satisfies ClineSayTool)

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await cline.diffViewProvider.open(relPath)
			await cline.diffViewProvider.update(updatedContent, true)
			cline.diffViewProvider.scrollToFirstDiff()
		}

		// Ask for approval (same for both flows)
		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			// Revert changes if diff view was shown
			if (!isPreventFocusDisruptionEnabled) {
				await cline.diffViewProvider.revertChanges()
			}
			pushToolResult("Changes were rejected by the user.")
			await cline.diffViewProvider.reset()
			return
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			// Direct file write without diff view or opening the file
			await cline.diffViewProvider.saveDirectly(relPath, updatedContent, false, diagnosticsEnabled, writeDelayMs)
		} else {
			// Call saveChanges to update the DiffViewProvider properties
			await cline.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
		}

		// Track file edit operation
		if (relPath) {
			await cline.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		cline.didEditFile = true

		// Get the formatted response message
		const message = await cline.diffViewProvider.pushToolWriteResult(cline, cline.cwd, !fileExists)

		pushToolResult(message)

		await cline.diffViewProvider.reset()

		// Process any queued messages after file edit completes
		cline.processQueuedMessages()
	} catch (error) {
		handleError("insert content", error)
		await cline.diffViewProvider.reset()
	}
}
