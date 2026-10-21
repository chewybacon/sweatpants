(use-modules (wasm types) (ice-9 match) (srfi srfi-1))

;; Transform Hoot's structured module before assembly. This is our pass, not
;; an upstream fuel facility. Host imports and native allocation are unmetered.
(define (meter-module wasm)
  (when (any (lambda (export) (equal? (export-name export) "__fuel"))
             (wasm-exports wasm))
    (error "module already exports __fuel"))
  (let* ((index (+ (count (lambda (i) (eq? (import-kind i) 'global))
                         (wasm-imports wasm))
                   (length (wasm-globals wasm))))
         (tick `((global.get ,index) (i64.const 1) (i64.sub) (global.set ,index)
                 (global.get ,index) (i64.const 0) (i64.lt_s)
                 (if #f #f ((unreachable)) ())))
         (loops 0))
    (define (walk instruction)
      (match instruction
        (('loop label type body)
         (set! loops (+ loops 1))
         `(loop ,label ,type ,(append tick (map walk body))))
        (('loop . _) (error "unsupported WASM loop representation" instruction))
        ((? pair?) (map walk instruction))
        (_ instruction)))
    (let ((functions
           (map (lambda (function)
                  (make-func (func-id function) (func-type function) (func-locals function)
                             (append tick (map walk (func-body function)))))
                (wasm-funcs wasm))))
      (when (or (null? functions) (zero? loops))
        (error "expected evaluator functions and loops"))
      (values
       (make-wasm (wasm-id wasm) (wasm-types wasm) (wasm-imports wasm) functions
         (wasm-tables wasm) (wasm-memories wasm)
         (append (wasm-globals wasm)
                 (list (make-global #f (make-global-type #t 'i64) '((i64.const 100000000)))))
         (append (wasm-exports wasm) (list (make-export "__fuel" 'global index)))
         (wasm-start wasm) (wasm-elems wasm) (wasm-datas wasm) (wasm-tags wasm)
         (wasm-strings wasm) (wasm-custom wasm))
       (length functions) loops))))
