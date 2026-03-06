---
name: smart-summarizer
description: "Summarize any content — articles, PDFs, YouTube videos, web pages, long documents, or pasted text. Use when user says 'summarize', 'tldr', 'summary', 'key points', 'what does this say', or pastes a URL asking what it's about. Extracts key points, action items, and insights."
---

# Smart Summarizer

Summarize anything — articles, videos, PDFs, meetings, or raw text.

## What It Can Summarize

| Source | How to Use |
|--------|-----------|
| Web article | User pastes URL |
| YouTube video | User pastes YouTube URL |
| PDF / document | User pastes text content |
| Meeting notes | User pastes transcript |
| Long email | User pastes email body |
| Any text | User just pastes it |

## Summary Modes

### Quick (3 bullets)
Best for: News articles, emails, short posts.
Trigger: "quick summary", "tldr", or short content.

Returns 3 bullet points. Done.

### Standard (structured)
Best for: Blog posts, reports, research.
Trigger: "summarize" with a URL or text.

Returns:
- **TL;DR** — 1 sentence
- **Key Points** — 3-5 bullets
- **Takeaway** — what to do with this info

### Deep Analysis
Best for: Research papers, long reports, books.
Trigger: "deep summary", "analyze", or long/complex content.

Returns:
- Executive summary
- Main arguments with evidence
- Counterarguments / limitations
- Actionable insights
- Recommended next steps

### Meeting Notes
Best for: Transcripts, call recordings.
Trigger: "meeting notes" or transcript content.

Returns:
- Attendees & context
- Decisions made
- Action items (with owners if mentioned)
- Open questions

## How to Fetch Content

1. For URLs: Use the WebFetch tool to retrieve the page content
2. For YouTube URLs: Use WebFetch to get the page, extract transcript if available
3. For pasted text: Summarize directly
4. For PDFs: If user provides a file path, read it directly

## Output Languages

Summarize in any language the user requests:
- "Summarize in Spanish: [URL]"
- "用中文总结: [URL]"

## Tips

- Works best with public URLs (no login required)
- For paywalled content, ask user to paste the text directly
- Keep summaries concise — match the mode to content length
- When on Discord/Telegram, default to Quick mode unless asked otherwise
