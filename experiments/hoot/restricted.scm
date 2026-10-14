(use-modules (hoot eval) (hoot environments) (hoot control))

;; The host owns persistence. These continuations live only in this WASM instance.
(define tag (make-prompt-tag 'effect))
(define pending #f)
(define finished? #f)
(define (effect name payload)
  (unless (and (string? name) (member name '("random" "ask")))
    (error "effect capability denied"))
  (unless (and (string? payload) (<= (string-length payload) 4096))
    (error "effect payload must be a bounded string"))
  (abort-to-prompt tag name payload))
(define (drive thunk)
  (call-with-prompt tag
    thunk
    (lambda (continuation name payload)
      (set! pending continuation)
      (values "effect" name payload))))
(define (start source)
  (unless (and (string? source) (<= (string-length source) 12000))
    (error "source exceeds limit"))
  (when (or pending finished?) (error "program already started"))
  (drive (lambda ()
    (let ((result ((eval `(lambda (effect) ,(call-with-input-string source read))
                        (environment '(only (scheme base)
                           lambda let let* letrec if begin quote define
                           let-syntax syntax-rules
                           + - * = < > not cons car cdr list null? pair?
                           string-append number->string))) effect)))
      (set! finished? #t)
      (values "done" result)))))

(define (next result)
  (unless pending (error "no pending effect"))
  (let ((continuation pending))
    (set! pending #f)
    (drive (lambda () (continuation result)))))
(values start next)
