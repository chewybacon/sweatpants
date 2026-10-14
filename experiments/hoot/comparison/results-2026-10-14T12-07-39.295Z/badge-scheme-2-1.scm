(let-syntax
  ((with-reply
    (syntax-rules ()
      ((_ expr id body)
       (let ((r expr))
         (if (equal? (field r "action") "accept")
             (let ((id (field (field r "content") "reply")))
               body)
             (object (cons "status" (field r "action")))))))))
  (letrec
    ((ask-name
      (lambda ()
        (with-reply
         (effect "ask" (object (cons "message" "Hi! What is your name?")))
         name
         (ask-color name))))
     (ask-color
      (lambda (name)
        (with-reply
         (effect "ask" (object (cons "message" "What is your favorite color?")))
         color
         (review name color))))
     (review
      (lambda (name color)
        (with-reply
         (effect "ask"
                 (object
                  (cons "message"
                        (string-append "Name badge: " name
                                       " | Favorite color: " color
                                       ". Say done, change name, or change color."))
                  (cons "suggestions"
                        (array "done" "change name" "change color"))))
         choice
         (if (equal? choice "done")
             (object (cons "status" "done")
                     (cons "name" name)
                     (cons "color" color))
             (if (equal? choice "change name")
                 (with-reply
                  (effect "ask" (object (cons "message" "What would you like your name to be?")))
                  new-name
                  (review new-name color))
                 (if (equal? choice "change color")
                     (with-reply
                      (effect "ask" (object (cons "message" "What would you like your favorite color to be?")))
                      new-color
                      (review name new-color))
                     (review name color))))))))
    (ask-name)))
