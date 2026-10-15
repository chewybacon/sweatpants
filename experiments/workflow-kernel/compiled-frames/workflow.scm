(define (choose ctx question) (define answer (yield-at "choose/answer" (list "elicit" question))) answer)
(define (plan ctx destination) (define seat (choose ctx "Pick a seat")) (define confirmed (yield-at "plan/confirmed" (list "elicit" "Confirm booking"))) (list destination seat confirmed))
(define (workflow ctx) (define destination (choose ctx "Pick a destination")) (define booking (plan ctx destination)) booking)
(workflow #f)
