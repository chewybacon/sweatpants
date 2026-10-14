(use-modules (hoot compile) (hoot config) (wasm assemble)
             (ice-9 binary-ports))
(load "meter.scm")

;; compile-file returns the structured module when no output file is supplied.
;; Meter after optimization, then assemble exactly once.
(let ((output (cadr (command-line))))
  (call-with-values
      (lambda ()
        (meter-module (compile-file "scripts/kernel.scm"
                        #:feature-options '(runtime-modules)
                        #:debug-level 0)))
    (lambda (module functions loops)
      (call-with-output-file (string-append output "/kernel.wasm")
        (lambda (port) (put-bytevector port (assemble-wasm module))) #:binary #t)
      (call-with-output-file (string-append output "/metering.json")
        (lambda (port)
          (format port "{\"functions\":~a,\"loops\":~a}\n" functions loops)))))
  (copy-file (string-append %reflect-js-dir "/reflect.js")
             (string-append output "/reflect.js"))
  (for-each (lambda (name)
              (copy-file (string-append %reflect-wasm-dir "/" name)
                         (string-append output "/" name)))
            '("reflect.wasm" "wtf8.wasm")))
