(letrec
  ((norm
    (lambda (r)
      (if (equal? r "rock") "rock"
        (if (equal? r "Rock") "rock"
          (if (equal? r "paper") "paper"
            (if (equal? r "Paper") "paper"
              (if (equal? r "scissors") "scissors"
                (if (equal? r "Scissors") "scissors" "none"))))))))
   (beats?
    (lambda (p c)
      (if (equal? p "rock") (equal? c "scissors")
        (if (equal? p "paper") (equal? c "rock")
          (equal? c "paper")))))
   (outcome
    (lambda (m c)
      (if (equal? m c) "tie"
        (if (beats? m c) "win" "loss"))))
   (play
    (lambda (round w l t msg)
      (if (= round 4)
          (object (cons "status" "done")
                  (cons "wins" w)
                  (cons "losses" l)
                  (cons "ties" t))
          (let ((resp (effect "ask"
                        (object (cons "message" msg)
                                (cons "suggestions"
                                      (array "rock" "paper" "scissors"))))))
            (let ((action (field resp "action")))
              (if (equal? action "accept")
                  (let ((move (norm (field (field resp "content") "reply"))))
                    (if (equal? move "none")
                        (play round w l t
                              "That is not a valid move. Choose rock, paper, or scissors.")
                        (let ((cpu (effect "random"
                                     (object (cons "choices"
                                                   (array "rock" "paper" "scissors")))))
                              )
                          (let ((res (outcome move cpu)))
                            (let ((w2 (if (equal? res "win") (+ w 1) w))
                                  (l2 (if (equal? res "loss") (+ l 1) l))
                                  (t2 (if (equal? res "tie") (+ t 1) t)))
                              (let ((msg2
                                     (string-append
                                       (string-append
                                         (string-append "You chose " move)
                                         (string-append ", I chose " cpu))
                                       (string-append
                                         (string-append ": " res)
                                         (string-append ". Round "
                                           (number->string (+ round 1)))))))
                                (play (+ round 1) w2 l2 t2
                                      (string-append msg2
                                        " of 3: choose rock, paper, or scissors."))))))))
                  (object (cons "status" action)))))))))
  (play 1 0 0 0 "Round 1 of 3: choose rock, paper, or scissors.")))
