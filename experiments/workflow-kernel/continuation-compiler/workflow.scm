(define (nested base turn)
  (let ((captured (+ base turn)))
    (+ captured (yield (list turn captured)))))
(define (loop turn total)
  (if (= turn 4)
      total
      (loop (+ turn 1) (nested total turn))))
(begin
  (yield "prefix")
  (loop 0 10))
