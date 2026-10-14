(use-modules (hoot eval) (hoot user) (hoot control))

;; The host owns persistence. These continuations live only in this WASM instance.
(define tag (make-prompt-tag 'effect))
(define pending #f)
(define finished? #f)
(define (effect name payload)
  (abort-to-prompt tag name payload))
(define (drive thunk)
  (call-with-prompt tag
    thunk
    (lambda (continuation name payload)
      (set! pending continuation)
      (values "effect" name payload))))
(define (start source)
  (when (or pending finished?) (error "program already started"))
  (drive (lambda ()
    (let ((result ((eval `(lambda (effect) ,(call-with-input-string source read))
                        (interaction-environment)) effect)))
      (set! finished? #t)
      (values "done" result)))))

(define (next result)
  (unless pending (error "no pending effect"))
  (let ((continuation pending))
    (set! pending #f)
    (drive (lambda () (continuation result)))))
(values start next)
