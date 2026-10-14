;;; Eval
;;; Copyright (C) 2024 Igalia, S.L.
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

(library (hoot eval)
  (export eval)
  (import (hoot errors)
          (hoot expander)
          (hoot modules)
          (hoot primitive-eval)
          (hoot syntax)
          (hoot syntax-objects))

  (define* (eval exp env)
    (check-type env module? 'eval)
    (primitive-eval (expand-syntax (if (syntax? exp)
                                       exp
                                       (datum->syntax #f exp))
                                   env)
                    env)))
