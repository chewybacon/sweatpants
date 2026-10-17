export const schemeExamples = [
  {
    program:
      '(let ()\n  (define (interpret reply)\n    (let* ((text (field (field reply "content") "reply"))\n           (request (object-set (field input "classifier") "input" text))\n           (result (decision request)))\n      (match-result (field result "answer") "type"\n        ("choice" answer (field answer "choice"))\n        (else other other))))\n  (match-result (ask (field input "question")) "action"\n    ("accept" reply (interpret reply))\n    (else stopped stopped)))',
    input: {
      question: {
        message: "Which kind of help do you need?",
      },
      classifier: {
        question: {
          type: "choice",
          instructions: "Choose the kind of help requested.",
          choices: [
            {
              value: "billing",
              description: "Bills or payments",
            },
            {
              value: "technical",
              description: "Technical assistance",
            },
            {
              value: "unclear",
              description: "Not enough information",
            },
          ],
        },
      },
    },
  },
];
