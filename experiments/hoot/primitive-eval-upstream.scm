;;; Eval
;;; Copyright (C) 2024, 2025 Igalia, S.L.
;;;
;;; Licensed under the Apache License, Version 2.0 (the "License");
;;; you may not use this file except in compliance with the License.
;;; You may obtain a copy of the License at
;;;
;;;    http://www.apache.org/licenses/LICENSE-2.0
;;;
;;; Unless required by applicable law or agreed to in writing, software
;;; distributed under the License is distributed on an "AS IS" BASIS,
;;; WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
;;; See the License for the specific language governing permissions and
;;; limitations under the License.

;;; Commentary:
;;;
;;; Eval.  Derived from Andy Wingo's work on Guile's ice-9/eval.scm.
;;;
;;; Code:

(library (hoot primitive-eval)
  (export primitive-eval primitive-expression?)
  (import (hoot apply)
          (hoot eq)
          (hoot errors)
          (hoot exceptions)
          (hoot lists)
          (hoot modules)
          (hoot not)
          (hoot pairs)
          (hoot syntax)
          (hoot tree-il)
          (hoot values)
          (hoot vectors)
          (ice-9 match)
          (only (hoot assoc) assq-ref)
          (only (hoot keywords) keyword?)
          (only (hoot numbers) 1+ 1- + zero? < <=))

  (define (primitive-expression? exp) (tree-il? exp))

  (define-exception-type &unknown-module-error &violation
    make-unknown-module-error unknown-module-error?
    (name unknown-module-error-name))

  (define (primitive-eval exp toplevel-env)
    (check-type toplevel-env module? 'primitive-eval)

    (define (lookup-lexical var cenv)
      (let outer ((depth 0) (cenv cenv))
        (match cenv
          ((vars . cenv)
           (let inner ((idx 1) (vars vars))
             (match vars
               (() (outer (1+ depth) cenv))
               ((v . vars)
                (if (eq? v var)
                    (values depth idx)
                    (inner (1+ idx) vars)))))))))

    (define (lookup-toplevel mod name public?)
      ;; Unlike Guile, we don't have a state where a identifier can be
      ;; defined but unbound.
      (let ((mod (or (resolve-module toplevel-env mod)
                     (raise (make-unknown-module-error mod)))))
        (module-variable mod name #:private? (not public?)
                         #:found (lambda (var mod name) var))))

    (define (toplevel-define! mod name)
      (let ((mod (resolve-module toplevel-env mod)))
        (or (module-local-variable mod name)
            (module-define! mod name #f))))

    (define (compile-const exp)
      (lambda (env) exp))

    (define (compile-lexical-ref name var cenv)
      (call-with-values (lambda () (lookup-lexical var cenv))
        (lambda (depth idx)
          (lambda (env)
            (let lp ((depth depth) (env env))
              (if (zero? depth)
                  (vector-ref env idx)
                  (lp (1- depth) (vector-ref env 0))))))))
    
    (define (compile-lexical-set name var val cenv)
      (let ((val (compile val cenv)))
        (call-with-values (lambda () (lookup-lexical var cenv))
          (lambda (depth idx)
            (lambda (env)
              (let ((val (val env)))
                (let lp ((depth depth) (env env))
                  (if (zero? depth)
                      (vector-set! env idx val)
                      (lp (1- depth) (vector-ref env 0))))))))))
    
    (define (compile-module-ref mod name public? cenv)
      (let ((getter #f))
        (lambda (env)
          (unless getter
            (set! getter (lookup-toplevel mod name public?)))
          (getter))))

    (define (compile-module-set mod name val public? cenv)
      (let ((setter #f)
            (val (compile val cenv)))
        (lambda (env)
          (unless setter
            (set! setter (lookup-toplevel mod name public?)))
          (setter (val env)))))
    
    (define (compile-toplevel-ref mod name cenv)
      (compile-module-ref mod name #f cenv))
    (define (compile-toplevel-set mod name val cenv)
      (compile-module-set mod name #f val cenv))

    (define (compile-toplevel-define mod name val cenv)
      (let ((setter #f)
            (val (compile val cenv)))
        (lambda (env)
          (unless setter
            (set! setter (toplevel-define! mod name)))
          (setter (val env)))))
    
    (define (compile-if test consequent alternate cenv)
      (let ((test (compile test cenv))
            (consequent (compile consequent cenv))
            (alternate (compile alternate cenv)))
        (lambda (env)
          (if (test env)
              (consequent env)
              (alternate env)))))

    (define (compile-call f args cenv)
      (let ((f (compile f cenv)))
        (match args
          (()
           (lambda (env) ((f env))))
          ((a)
           (let ((a (compile a cenv)))
             (lambda (env) ((f env) (a env)))))
          ((a b)
           (let ((a (compile a cenv))
                 (b (compile b cenv)))
             (lambda (env) ((f env) (a env) (b env)))))
          ((a b c)
           (let ((a (compile a cenv))
                 (b (compile b cenv))
                 (c (compile c cenv)))
             (lambda (env) ((f env) (a env) (b env) (c env)))))
          ((a b c . d*)
           (let ((a (compile a cenv))
                 (b (compile b cenv))
                 (c (compile c cenv))
                 (d* (map (lambda (exp) (compile exp cenv)) d*)))
             (lambda (env)
               (apply (f env) (a env) (b env) (c env)
                      (map (lambda (exp) (exp env)) d*))))))))
    
    ;; If present, primitive-ref and primcall are produced by the
    ;; expander.  We just need to handle the set of primcalls that the
    ;; expander produces, which until the full expander lands, is just
    ;; memv in call position.
    (define (compile-primitive-ref prim cenv)
      ;; These essentially end up here via syntax-case output.
      (error "unexpected primitive-ref" prim))
    (define (compile-primcall prim args cenv)
      (define (delegate modname)
        (compile (make-call #f (make-module-ref #f modname prim #t) args) cenv))
      (case prim
        ((memv)
         (delegate '(hoot assoc)))
        ((make-syntax-transformer)
         (delegate '(hoot syntax-transformers)))
        ((list cons)
         (delegate '(hoot pairs)))
        ((map append)
         (delegate '(hoot lists)))
        ((vector list->vector)
         (delegate '(hoot vectors)))
        ((syntax-violation)
         (delegate '(hoot core-syntax-helpers)))
        ((apply)
         (delegate '(hoot apply)))
        (else
         (error "unexpected primcall" prim))))
    
    (define (compile-seq head tail cenv)
      (let ((head (compile head cenv))
            (tail (compile tail cenv)))
        (lambda (env)
          (head env)
          (tail env))))
    
    (define (compile-fixed-lambda req syms body cenv)
      (let* ((cenv (cons syms cenv))
             (body (compile body cenv)))
        (match syms
          (()      (lambda (env) (lambda ()      (body (vector env)))))
          ((a)     (lambda (env) (lambda (a)     (body (vector env a)))))
          ((a b)   (lambda (env) (lambda (a b)   (body (vector env a b)))))
          ((a b c) (lambda (env) (lambda (a b c) (body (vector env a b c)))))
          ((a b c . d)
           (let ((nreq (length syms)))
             (lambda (env)
               (lambda (a b c . d)
                 (let ((env (make-vector (1+ nreq) env)))
                   (vector-set! env 1 a)
                   (vector-set! env 2 b)
                   (vector-set! env 3 c)
                   (let lp ((i 4) (rest d))
                     (when (<= i nreq)
                       (vector-set! env i (car rest))
                       (lp (1+ i) (cdr rest))))
                   (body env)))))))))

    (define (compile-rest-lambda req rest syms body cenv)
      (let* ((cenv (cons syms cenv))
             (body (compile body cenv)))
        (match syms
          ((a)
           (lambda (env) (lambda a           (body (vector env a)))))
          ((a b)  
           (lambda (env) (lambda (a . b)     (body (vector env a b)))))
          ((a b c)
           (lambda (env) (lambda (a b . c)   (body (vector env a b c)))))
          ((a b c . d)
           (let ((nreq+rest (length syms)))
             (lambda (env)
               (lambda (a b c . d)
                 (let ((env (make-vector (1+ nreq+rest) env)))
                   (vector-set! env 1 a)
                   (vector-set! env 2 b)
                   (vector-set! env 3 c)
                   (let lp ((i 4) (rest d))
                     (cond
                      ((< i nreq+rest)
                       (vector-set! env i (car rest))
                       (lp (1+ i) (cdr rest)))
                      (else
                       (vector-set! env i rest)
                       (body env))))))))))))

    (define (compile-general-lambda req opt rest kw inits syms body alt cenv)
      (let* ((cenv (cons syms cenv))
             (body (compile body cenv))
             (inits (map (lambda (exp) (compile exp cenv)) inits)))
        (define nreq (length req))
        (define nopt (length opt))
        (define nvars (length syms))
        (define unbound (list 'unbound))
        (define rest-idx (and rest (+ nreq nopt 1)))
        (define allow-other-keys? (match kw (#f #f) ((aok? . _) aok?)))
        (define kw-indices
          (match kw
            (#f '())
            ((aok? (key name sym) ...)
             (let lp ((kw* key) (idx (+ nreq nopt (if rest 2 1))) )
               (match kw*
                 (() '())
                 ((kw . kw*) (acons kw idx (lp kw* (1+ idx)))))))))
        (lambda (env)
          (lambda args
            (define (next-case)
              (apply (if alt
                         (alt env)
                         (lambda args
                           (raise (make-arity-error args 'apply))))
                     args))
            (let ((env (let ((env* (make-vector (1+ nvars) unbound)))
                         (vector-set! env* 0 env)
                         env*)))
              (define (parse-req idx remaining args)
                (if (zero? remaining)
                    (parse-opt idx nopt args)
                    (match args
                      (() (next-case))
                      ((arg . args)
                       (vector-set! env idx arg)
                       (parse-req (1+ idx) (1- remaining) args)))))
              (define (parse-opt idx remaining args)
                (cond
                 ((zero? remaining)
                  (parse-rest args))
                 (else
                  (match args
                    (() (parse-rest '()))
                    ((arg . args)
                     (vector-set! env idx arg)
                     (parse-opt (1+ idx) (1- nreq) args))))))
              (define (parse-rest args)
                (cond
                 (rest-idx
                  (vector-set! env rest-idx args)
                  (if kw
                      (parse-kw args)
                      (finish)))
                 ((null? args)
                  (finish))
                 ((or (not kw)
                      (and alt (pair? args) (not (keyword? (car args)))))
                  ;; Too many positional arguments for this case.
                  (next-case))
                 (else
                  (parse-kw args))))
              (define (parse-kw args)
                (match args
                  (()
                   (finish))
                  ((k . args)
                   (match (assq-ref kw-indices k)
                     (#f
                      (cond
                       ((not (keyword? k))
                        (if rest-idx
                            (parse-kw args)
                            (raise (make-invalid-keyword-error k))))
                       (allow-other-keys?
                        (match args
                          (() (finish))
                          ((v . args) (parse-kw args))))
                       (else
                        (raise (make-unrecognized-keyword-error k)))))
                     (idx
                      (match args
                        (() (raise (make-missing-keyword-argument-error k)))
                        ((v . args)
                         (vector-set! env idx v)
                         (parse-kw args))))))))
              (define (finish)
                (let lp ((idx (+ nreq 1)) (inits inits))
                  (if (eq? idx rest-idx)
                      (lp (1+ idx) inits)
                      (match inits
                        (() (body env))
                        ((init . inits)
                         (when (eq? (vector-ref env idx) unbound)
                           (vector-set! env idx (init env)))
                         (lp (1+ idx) inits))))))

              (parse-req 1 nreq args))))))

    (define (compile-lambda-case body cenv)
      (match body
        (#f (lambda (env)
              (lambda args
                (raise (make-arity-error args 'apply)))))
        (($ <lambda-case> src req (or #f ()) #f #f () syms body #f)
         (compile-fixed-lambda req syms body cenv))
        (($ <lambda-case> src req (or #f ()) rest #f () syms body #f)
         (compile-rest-lambda req rest syms body cenv))
        (($ <lambda-case> src req opt rest kw inits syms body alt)
         (compile-general-lambda
          req (or opt '()) rest kw inits syms body
          (and alt (compile-lambda-case alt cenv))
          cenv))))

    (define (compile-lambda meta body cenv)
      (compile-lambda-case body cenv))

    (define (compile-let names vars inits body cenv)
      (let* ((inits (map (lambda (exp) (compile exp cenv)) inits))
             (cenv (cons vars cenv))
             (len (length inits))
             (body (compile body cenv)))
        (lambda (env)
          (let ((env* (make-vector (1+ len))))
            (vector-set! env* 0 env)
            (let lp ((i 0) (inits inits))
              (when (< i len)
                (vector-set! env* (1+ i) ((car inits) env))
                (lp (1+ i) (cdr inits))))
            (body env*)))))

    (define (compile-letrec in-order? names vars inits body cenv)
      (let* ((len (length inits))
             (cenv (cons vars cenv))
             (inits (map (lambda (exp) (compile exp cenv)) inits))
             (body (compile body cenv)))
        (lambda (env)
          (let ((env* (make-vector (1+ len))))
            (vector-set! env* 0 env)
            (let lp ((i 0) (inits inits))
              (when (< i len)
                (vector-set! env* (1+ i) ((car inits) env*))
                (lp (1+ i) (cdr inits))))
            (body env*)))))

    (define (compile exp cenv)
      (match exp
        (($ <void> src)
         (compile-const (if #f #f)))

        (($ <const> src exp)
         (compile-const exp))

        (($ <primitive-ref> src name)
         (compile-primitive-ref name cenv))
        
        (($ <lexical-ref> src name var)
         (compile-lexical-ref name var cenv))
        
        (($ <lexical-set> src name var val)
         (compile-lexical-set name var val cenv))
        
        (($ <toplevel-ref> src mod name)
         (compile-toplevel-ref mod name cenv))

        (($ <toplevel-set> src mod name val)
         (compile-toplevel-set mod name val cenv))

        (($ <toplevel-define> src mod name val)
         (compile-toplevel-define mod name val cenv))
        
        (($ <module-ref> src mod name public?)
         (compile-module-ref mod name public? cenv))

        (($ <module-set> src mod name public? val)
         (compile-module-set mod name public? val cenv))

        (($ <conditional> src test consequent alternate)
         (compile-if test consequent alternate cenv))

        (($ <call> src f args)
         (compile-call f args cenv))
        
        (($ <primcall> src prim args)
         (compile-primcall prim args cenv))
        
        (($ <seq> src head tail)
         (compile-seq head tail cenv))
        
        (($ <lambda> src meta body)
         (compile-lambda meta body cenv))

        (($ <let> src names vars inits body)
         (compile-let names vars inits body cenv))

        (($ <letrec> src in-order? names vars inits body)
         (compile-letrec in-order? names vars inits body cenv))))

    ((compile exp 'compile-env) 'lexical-env)))
