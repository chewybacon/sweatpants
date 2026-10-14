(letrec ((beats?
         (lambda (a b)
           (or (and (equal? a "rock") (equal? b "scissors"))
               (and (equal? a "scissors") (equal? b "paper"))
               (and (equal? a "paper") (equal? b "rock")))))
        (valid?
         (lambda (r)
           (or (equal? r "rock")
               (equal? r "paper")
               (equal? r "scissors"))))
        (play
         (lambda (round wins losses ties note)
           (if (> round 3)
               (object (cons "status" "done")
                       (cons "wins" wins)
                       (cons "losses" losses)
                       (cons "ties" ties))
               (let ask-loop ((note-now note))
                 (let* ((res (effect "ask"
                               (object (cons "message"
                                             (string-append note-now
                                                            "Round "
                                                            (number->string round)
                                                            " of 3: choose rock, paper, or scissors."))
                                       (cons "suggestions"
                                             (array "rock" "paper" "scissors")))))
                        (action (field res "action")))
                   (if (equal? action "accept")
                       (let ((reply (field (field res "content") "reply")))
                         (if (valid? reply)
                             (let* ((cpu (effect "random"
                                           (object (cons "choices"
                                                         (array "rock" "paper" "scissors")))))
                                    (note2 (string-append "You played " reply
                                                          ", I played " cpu ". ")))
                               (if (equal? reply cpu)
                                   (play (+ round 1) wins losses (+ ties 1)
                                         (string-append note2 "Tie! "))
                                   (if (beats? reply cpu)
                                       (play (+ round 1) (+ wins 1) losses ties
                                             (string-append note2 "You win! "))
                                       (play (+ round 1) wins (+ losses 1) ties
                                             (string-append note2 "I win! ")))))
                             (ask-loop "Invalid reply. ")))
                       (object (cons "status" action))))))))
  (play 1 0 0 0 ""))
