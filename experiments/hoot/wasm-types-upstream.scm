;;; WebAssembly data types
;;; Copyright (C) 2023, 2026 Igalia, S.L.
;;; Copyright (C) 2023 Christine Lemmer-Webber <christine@spritely.institute>
;;; Copyright (C) 2023 Robin Templeton <robin@spritely.institute>
;;; Copyright (C) 2023, 2024 David Thompson <dave@spritely.institute>
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
;;; This module defines all of the data types that form a WebAssembly
;;; module.
;;;
;;; Code:

(define-module (wasm types)
  #:use-module (srfi srfi-9)
  #:use-module (srfi srfi-9 gnu)
  #:use-module (ice-9 match)
  #:export (<wasm>
            make-wasm wasm?
            wasm-id wasm-types wasm-imports wasm-funcs wasm-tables wasm-memories
            wasm-globals wasm-exports wasm-start wasm-elems wasm-datas
            wasm-tags wasm-strings wasm-custom

            <param>
            make-param param?
            param-id param-type

            <func-sig>
            make-func-sig func-sig?
            func-sig-params func-sig-results

            <type-use>
            make-type-use type-use?
            type-use-idx type-use-sig

            <ref-type>
            make-ref-type ref-type?
            ref-type-nullable? ref-type-heap-type

            <limits>
            make-limits limits?
            limits-min limits-max

            <table-type>
            make-table-type table-type?
            table-type-limits table-type-elem-type

            <mem-type>
            make-mem-type mem-type?
            mem-type-limits

            <global-type>
            make-global-type global-type?
            global-type-mutable? global-type-type

            <tag-type>
            make-tag-type tag-type?
            tag-type-attribute tag-type-type

            <array-type>
            make-array-type array-type?
            array-type-mutable?
            array-type-type

            <field>
            make-field field?
            field-id field-mutable? field-type

            <struct-type>
            make-struct-type struct-type?
            struct-type-fields

            <sub-type>
            make-sub-type sub-type?
            sub-type-final? sub-type-supers sub-type-type

            <rec-group>
            make-rec-group rec-group?
            rec-group-types

            <host-type>
            make-host-type host-type?
            host-type-id

            <type>
            make-type type?
            type-id type-val

            <import>
            make-import import?
            import-mod import-name import-kind import-id import-type

            <export>
            make-export export?
            export-name export-kind export-idx

            <mem-arg>
            make-mem-arg mem-arg?
            mem-arg-id mem-arg-offset mem-arg-align

            <elem>
            make-elem elem?
            elem-id elem-mode elem-table elem-type elem-offset elem-inits

            <data>
            make-data data?
            data-id data-mode data-mem data-offset data-init

            <tag>
            make-tag tag?
            tag-id tag-type

            <local>
            make-local local?
            local-id local-type

            <func>
            make-func func?
            func-id func-type func-locals func-body

            <table>
            make-table table?
            table-id table-type table-init

            <memory>
            make-memory memory?
            memory-id memory-type

            <global>
            make-global global?
            global-id global-type global-init

            <custom>
            make-custom custom?
            custom-name custom-bytes

            <names>
            make-names names?
            names-module names-func names-local names-label names-type
            names-table names-memory names-global names-elem names-data
            names-field names-tag

            find-type))

(define-record-type <wasm>
  (make-wasm id types imports funcs tables memories
             globals exports start elems datas tags
             strings custom)
  wasm?
  (id wasm-id)
  (types wasm-types)
  (imports wasm-imports)
  (funcs wasm-funcs)
  (tables wasm-tables)
  (memories wasm-memories)
  (globals wasm-globals)
  (exports wasm-exports)
  (start wasm-start)
  (elems wasm-elems)
  (datas wasm-datas)
  (tags wasm-tags)
  (strings wasm-strings)
  (custom wasm-custom))

(define (print-wasm wasm port)
  (format port "#<wasm ~a>" (object-address wasm)))

(set-record-type-printer! <wasm> print-wasm)

(define-record-type <param>
  (make-param id type)
  param?
  (id param-id)
  (type param-type))

(define-record-type <func-sig>
  (make-func-sig params results)
  func-sig?
  (params func-sig-params)
  (results func-sig-results))

(define-record-type <type-use>
  (make-type-use idx sig)
  type-use?
  (idx type-use-idx)
  (sig type-use-sig))

(define-record-type <ref-type>
  (make-ref-type nullable? heap-type)
  ref-type?
  (nullable? ref-type-nullable?)
  (heap-type ref-type-heap-type))

(define-record-type <limits>
  (make-limits min max)
  limits?
  (min limits-min)
  (max limits-max))

(define-record-type <table-type>
  (make-table-type limits elem-type)
  table-type?
  (limits table-type-limits)
  (elem-type table-type-elem-type))

(define-record-type <mem-type>
  (make-mem-type limits)
  mem-type?
  (limits mem-type-limits))

(define-record-type <global-type>
  (make-global-type mutable? type)
  global-type?
  (mutable? global-type-mutable?)
  (type global-type-type))

(define-record-type <tag-type>
  (make-tag-type attribute type)
  tag-type?
  (attribute tag-type-attribute)
  (type tag-type-type))

(define-record-type <array-type>
  (make-array-type mutable? type)
  array-type?
  (mutable? array-type-mutable?)
  (type array-type-type))

(define-record-type <field>
  (make-field id mutable? type)
  field?
  (id field-id)
  (mutable? field-mutable?)
  (type field-type))

(define-record-type <struct-type>
  (make-struct-type fields)
  struct-type?
  (fields struct-type-fields))

(define-record-type <sub-type>
  (make-sub-type final? supers type)
  sub-type?
  (final? sub-type-final?)
  (supers sub-type-supers)
  (type sub-type-type))

(define-record-type <rec-group>
  (make-rec-group types)
  rec-group?
  (types rec-group-types))

(define-record-type <host-type>
  (make-host-type id)
  host-type?
  (id host-type-id))

(define-record-type <type>
  (make-type id val)
  type?
  (id type-id)
  (val type-val))

(define-record-type <import>
  (make-import mod name kind id type)
  import?
  (mod import-mod)
  (name import-name)
  (kind import-kind)
  (id import-id)
  (type import-type))

(define-record-type <export>
  (make-export name kind idx)
  export?
  (name export-name)
  (kind export-kind)
  (idx export-idx))

(define-record-type <mem-arg>
  (make-mem-arg id offset align)
  mem-arg?
  (id mem-arg-id)
  (offset mem-arg-offset)
  (align mem-arg-align))

(define-record-type <elem>
  (make-elem id mode table type offset inits)
  elem?
  (id elem-id)
  (mode elem-mode)
  (table elem-table)
  (type elem-type)
  (offset elem-offset)
  (inits elem-inits))

(define-record-type <data>
  (make-data id mode mem offset init)
  data?
  (id data-id)
  (mode data-mode)
  (mem data-mem)
  (offset data-offset)
  (init data-init))

(define-record-type <tag>
  (make-tag id type)
  tag?
  (id tag-id)
  (type tag-type))

(define-record-type <local>
  (make-local id type)
  local?
  (id local-id)
  (type local-type))

(define-record-type <func>
  (make-func id type locals body)
  func?
  (id func-id)
  (type func-type)
  (locals func-locals)
  (body func-body))

(define-record-type <table>
  (make-table id type init)
  table?
  (id table-id)
  (type table-type)
  (init table-init))

(define-record-type <memory>
  (make-memory id type)
  memory?
  (id memory-id)
  (type memory-type))

(define-record-type <global>
  (make-global id type init)
  global?
  (id global-id)
  (type global-type)
  (init global-init))

(define-record-type <names>
 (make-names module func local label type table
             memory global elem data field tag)
 names?
 (module names-module)
 (func names-func)
 (local names-local)
 (label names-label)
 (type names-type)
 (table names-table)
 (memory names-memory)
 (global names-global)
 (elem names-elem)
 (data names-data)
 (field names-field)
 (tag names-tag))

(define-record-type <custom>
  (make-custom name bytes)
  custom?
  (name custom-name)
  (bytes custom-bytes))

(define (find-type pred types)
  (let lp ((types types) (idx 0))
    (define (visit-base rec supers type-id type-idx type)
      (pred rec type-id type-idx supers type))
    (define (visit-sub rec type-id type-idx type)
      (match type
        (($ <sub-type> final? supers type)
         (visit-base rec supers type-id type-idx type))
        (_ (visit-base rec '()  type-id type-idx type))))
    (match types
      (() #f)
      ((($ <rec-group> subtypes) . types)
       (let ((rec idx))
         (let lp2 ((subtypes subtypes) (idx idx))
           (match subtypes
             (() (lp types idx))
             ((($ <type> id subtype) . subtypes)
              (or (visit-sub rec id idx subtype)
                  (lp2 subtypes (1+ idx))))))))
      ((($ <type> id type) . types)
       (or (visit-sub idx id idx type)
           (lp types (1+ idx)))))))
