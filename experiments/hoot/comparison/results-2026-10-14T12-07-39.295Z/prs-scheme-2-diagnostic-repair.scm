(letrec
  ((normalize
    (lambda (r)
      (if (equal? r "rock") "rock"
      (if (equal? r "Rock") "rock"
      (if (equal? r "paper") "paper"
      (if (equal? r "Paper") "paper"
      (if (equal? r "scissors") "scissors"
      (if (equal? r "Scissors") "scissors"
      #f))))))))
   (beats?
    (lambda (p c)
      (if (equal? p "rock") (equal? c "scissors")
      (if (equal? p "scissors") (equal? c "paper")
      (if (equal? p "paper") (equal? c "rock") #f)))))
   (result-object
    (lambda (w l tc)
      (object (cons "status" "done")
              (cons "wins" w)
              (cons "losses" l)
              (cons "ties" tc))))
   (play
    (lambda (round w l tc msg)
      (if (= round 4)
          (result-object w l tc)
          (let ((resp (effect "ask"
                        (object (cons "message" msg)
                                (cons "suggestions" (array "rock" "paper" "scissors"))))))
            (let ((action (field resp "action")))
              (if (equal? action "accept")
                  (let ((move (normalize (field (field resp "content") "reply"))))
                    (if move
                        (let* ((cpu (effect "random"
                                      (object (cons "choices" (array "rock" "paper" "scissors")))))
                               (outcome (if (equal? move cpu) "tie"
                                          (if (beats? move cpu) "win" "loss")))
                               (w2 (if (equal? outcome "win") (+ w 1) w))
                               (l2 (if (equal? outcome "loss") (+ l 1) l))
                               (t2 (if (equal? outcome "tie") (+ tc 1) tc))
                               (msg2 (string-append
                                       "You chose " move ", I chose " cpu
                                       ": " outcome ". Round "
                                       (number->string (+ round 1))
                                       " of 3: choose rock, paper, or scissors.")))
                          (play (+ round 1) w2 l2 t2 msg2))
                        (play round w l tc
                              "That is not a valid move. Choose rock, paper, or scissors.")))
                  (object (cons "status" action)))))))))
  (play 1 0 0 0 "Round 1 of 3: choose rock, paper, or scissors."))
