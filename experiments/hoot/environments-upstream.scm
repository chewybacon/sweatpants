;;; Modules
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
;;; Run-time representation of module trees.
;;;
;;; Code:

(library (hoot environments)
  (export environment)
  (import (hoot assoc)
          (hoot cond-expand)
          (hoot errors)
          (hoot exceptions)
          (hoot gensym)
          (hoot lists)
          (hoot modules)
          (hoot not)
          (hoot numbers)
          (hoot pairs)
          (hoot strings)
          (hoot symbols)
          (hoot syntax)
          (hoot values)
          (ice-9 match))

  (define-exception-type &unknown-module &violation
    make-unknown-module-error unknown-module-error?
    (name unknown-module-name))

  (define (load-module root name)
    #f)

  (define (environment . import-sets)
    (define root (the-root-module))
    (unless root
      (cond-expand
       (runtime-modules
        (error "No root module even though -fruntime-modules, WTF?"))
       (else
        (error "No run-time module registry; recompile with -fruntime-modules"))))
    (define (id? x) (symbol? x))
    (define (name-component? x) (id? x))
    (define (version-component? x) (and (exact-integer? x) (not (negative? x))))
    (define parse-name+version
      (match-lambda
        (((? name-component? name) ... ((? version-component? version) ...))
         (values name version))
        (((? name-component? name) ...)
         (values name '()))))
    (define (make-interface src)
      (make-empty-module #:name (module-name src) #:root root))
    (define parse-import-set
      (match-lambda
        ((head . tail)
         (match head
           ('only
            (match tail
              ((iset (? id? select) ...)
               (let* ((src (parse-import-set iset))
                      (dst (make-interface src)))
                 (for-each (lambda (id)
                             (module-import! dst src id)
                             (module-export! dst id))
                           select)
                 dst))))
           ('except
            (match tail
              ((iset (? id? hide) ...)
               (let* ((src (parse-import-set iset))
                      (dst (make-interface src)))
                 (for-each (lambda (id)
                             (unless (memq id hide)
                               (module-import! dst src id)
                               (module-export! dst id)))
                           (module-exported-names src))
                 dst))))
           ('prefix
            (match tail
              ((iset (? id? prefix))
               (let* ((src (parse-import-set iset))
                      (dst (make-interface src)))
                 (for-each (lambda (id)
                             (module-import! dst src id)
                             (module-export! dst (symbol-append prefix id) id))
                           (module-exported-names src))
                 dst))))
           ('rename
            (match tail
              ((iset ((? id? from) (? id? to)) ...)
               (let* ((src (parse-import-set iset))
                      (dst (make-interface src))
                      (trans (map cons from to)))
                 (for-each (lambda (id)
                             (module-import! dst src id)
                             (module-export! dst (or (assq-ref trans id) id) id))
                           (module-exported-names src))
                 dst))))
           ('library
               (match tail
                 ((name+version)
                  (call-with-values (lambda ()
                                      (parse-name+version name+version))
                    (lambda (name version)
                      (or (resolve-module root name)
                          (load-module root name)
                          (raise-exception (make-unknown-module-error name))))))))
           (_
            (parse-import-set `(library (,head . ,tail))))))))

    (let ((env (make-empty-module #:name (list (gensym)) #:root root)))
      (for-each (lambda (iset)
                  (let ((src (parse-import-set iset)))
                    (for-each (lambda (id) (module-import! env src id))
                              (module-exported-names src))))
                import-sets)
      env)))
