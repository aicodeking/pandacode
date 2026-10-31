# Edit and rewind a sent prompt

Every saved user message has an **Edit** action (pencil) beside Copy and Fork.
It forks the conversation to just *before* that message into a new task in the
same checkout, and puts the message's typed text into the new task's composer
to fix and send. The source task is unchanged.

- Native: `fork_session_at_message` with `exclusive: true` calls
  `conversation_fork::before_message`, the ordinary fork with the boundary
  message left out. Like every fork, the new task has no resume ID: the next
  message starts a fresh harness session that receives the copied transcript
  through context recovery, so the dropped prompt never reaches the harness.
- Attached context (files, documents, images) is not re-attached; only the
  text before the first context block returns to the composer.
- Files are not rewound. Edit is disabled while an agent runs on the thread.
