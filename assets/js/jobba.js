/* Jobba hos oss: ansökningsformuläret på /jobba-hos-oss.
   Ansökan skickas till /api/ansokan, som mejlar den med CV, personligt brev och referens bifogade. */
(function () {
    "use strict";

    var ALLOWED = ["pdf", "doc", "docx"];
    // Vercel tar emot högst 4,5 MB per anrop, inklusive text och multipart-overhead.
    var MAX_TOTAL = 4 * 1024 * 1024;
    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var NETWORK_ERROR = "Vi kunde inte nå servern. Kontrollera din internetanslutning och försök igen.";
    var SEND_ERROR = "Vi kunde inte skicka din ansökan just nu. Försök igen om en stund eller mejla hej@effektivmedia.nu.";
    var TOO_LARGE = "Filerna är för stora. Bifoga högst 4 MB totalt.";
    var ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

    function $(id) {
        return document.getElementById(id);
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function extension(name) {
        var match = /\.([^.]+)$/.exec(String(name || ""));
        return match ? match[1].toLowerCase() : "";
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " kB";
        return (bytes / (1024 * 1024)).toLocaleString("sv-SE", { maximumFractionDigits: 1 }) + " MB";
    }

    function scrollToEl(node) {
        var top = node.getBoundingClientRect().top + window.pageYOffset - 130;
        window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
    }

    function markInvalid(field, invalid) {
        field.classList.toggle("is-invalid", invalid);
        Array.prototype.forEach.call(field.querySelectorAll("input:not([type=radio]):not([type=file]), textarea"), function (input) {
            if (invalid) input.setAttribute("aria-invalid", "true");
            else input.removeAttribute("aria-invalid");
        });
    }

    /* ---------- Filväljare för en fil, med dra-och-släpp ---------- */
    function FilePicker(field, otherSize) {
        var input = field.querySelector("input[type=file]");
        var drop = field.querySelector("[data-drop]");
        var list = field.querySelector("[data-file-list]");
        var error = field.querySelector("[data-file-error]");
        var defaultError = error.textContent;
        var file = null;

        function setError(message) {
            error.textContent = message || defaultError;
            markInvalid(field, Boolean(message));
        }

        function render() {
            list.innerHTML = "";
            if (!file) return;
            var item = el("li", "arende-file");
            var icon = el("span", "arende-file-icon");
            icon.innerHTML = ICON_FILE;
            var remove = el("button", "arende-file-remove");
            remove.type = "button";
            remove.setAttribute("aria-label", "Ta bort " + file.name);
            remove.innerHTML = ICON_X;
            remove.addEventListener("click", function () {
                file = null;
                setError("");
                render();
                input.focus();
            });
            item.appendChild(icon);
            item.appendChild(el("span", "arende-file-name", file.name));
            item.appendChild(el("span", "arende-file-size", formatBytes(file.size)));
            item.appendChild(remove);
            list.appendChild(item);
        }

        function add(selected) {
            setError("");
            if (selected) {
                if (ALLOWED.indexOf(extension(selected.name)) === -1) {
                    setError(selected.name + " kan inte bifogas. Skicka en PDF eller ett Word-dokument.");
                } else if (selected.size === 0) {
                    setError(selected.name + " är tom.");
                } else if (selected.size + otherSize() > MAX_TOTAL) {
                    setError(selected.name + " får inte plats – filerna får vara högst 4 MB tillsammans.");
                } else {
                    file = selected;
                }
            }
            render();
            input.value = "";
        }

        input.addEventListener("change", function () {
            add(input.files[0]);
        });
        ["dragenter", "dragover"].forEach(function (type) {
            drop.addEventListener(type, function (event) {
                event.preventDefault();
                drop.classList.add("is-dragover");
            });
        });
        ["dragleave", "dragend"].forEach(function (type) {
            drop.addEventListener(type, function () {
                drop.classList.remove("is-dragover");
            });
        });
        drop.addEventListener("drop", function (event) {
            event.preventDefault();
            drop.classList.remove("is-dragover");
            if (event.dataTransfer && event.dataTransfer.files) add(event.dataTransfer.files[0]);
        });

        return {
            file: function () {
                return file;
            },
            size: function () {
                return file ? file.size : 0;
            },
            setError: setError
        };
    }

    function init(form) {
        var alertBox = $("jobbaAlert");
        var alertText = $("jobbaAlertText");
        var submit = $("jobbaSubmit");
        var submitLabel = submit.querySelector(".text-btn");
        var defaultLabel = submitLabel.textContent;
        var success = $("jobbaSuccess");
        var cvField = $("field-cv");
        var cv = FilePicker(cvField, function () {
            return letter.size() + referenceFile.size();
        });
        var letter = FilePicker($("field-letter"), function () {
            return cv.size() + referenceFile.size();
        });
        var referenceFile = FilePicker($("field-referencefile"), function () {
            return cv.size() + letter.size();
        });

        function value(name) {
            var input = form.elements[name];
            return input ? String(input.value || "").trim() : "";
        }

        var CHECKS = {
            name: function (v) { return Boolean(v); },
            email: function (v) { return EMAIL_PATTERN.test(v); },
            phone: function (v) { return v.replace(/\D/g, "").length >= 6; },
            city: function (v) { return Boolean(v); },
            experience: function (v) { return Boolean(v); },
            start: function (v) { return Boolean(v); }
        };

        function validate() {
            var firstInvalid = null;
            Object.keys(CHECKS).forEach(function (name) {
                var field = $("field-" + name);
                var invalid = !CHECKS[name](value(name));
                markInvalid(field, invalid);
                if (invalid && !firstInvalid) firstInvalid = field;
            });
            if (!cv.file()) {
                cv.setError("Bifoga ditt CV.");
                if (!firstInvalid) firstInvalid = cvField;
            }
            return firstInvalid;
        }

        function showAlert(message) {
            alertText.textContent = message || "";
            alertBox.hidden = !message;
            if (message) scrollToEl(alertBox);
        }

        function setBusy(busy) {
            if (busy) {
                submit.setAttribute("disabled", "disabled");
                submit.setAttribute("aria-busy", "true");
                submitLabel.innerHTML = '<span class="arende-spinner" aria-hidden="true"></span>';
                submitLabel.appendChild(document.createTextNode("Skickar..."));
            } else {
                submit.removeAttribute("disabled");
                submit.removeAttribute("aria-busy");
                submitLabel.textContent = defaultLabel;
            }
        }

        Object.keys(CHECKS).forEach(function (name) {
            var field = $("field-" + name);
            ["input", "change"].forEach(function (type) {
                field.addEventListener(type, function () {
                    if (field.classList.contains("is-invalid") && CHECKS[name](value(name))) markInvalid(field, false);
                });
            });
        });

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            showAlert("");

            var firstInvalid = validate();
            if (firstInvalid) {
                scrollToEl(firstInvalid);
                var focusable = firstInvalid.querySelector("input, textarea");
                if (focusable) focusable.focus({ preventScroll: true });
                return;
            }

            var data = new FormData(form);
            data.append("cv", cv.file(), cv.file().name);
            if (letter.file()) data.append("letter", letter.file(), letter.file().name);
            if (referenceFile.file()) data.append("referencefile", referenceFile.file(), referenceFile.file().name);

            setBusy(true);
            fetch("/api/ansokan", { method: "POST", body: data })
                .then(function (response) {
                    // Fel från Vercel kan vara HTML i stället för JSON.
                    return response.json().catch(function () {
                        return {};
                    }).then(function (result) {
                        if (response.ok && result.ok) {
                            form.hidden = true;
                            success.hidden = false;
                            success.focus({ preventScroll: true });
                            scrollToEl(success);
                        } else if (response.status === 413) {
                            showAlert(TOO_LARGE);
                        } else {
                            showAlert(result.error || SEND_ERROR);
                        }
                    });
                })
                .catch(function () {
                    showAlert(NETWORK_ERROR);
                })
                .finally(function () {
                    setBusy(false);
                });
        });
    }

    var form = $("jobbaForm");
    if (form) init(form);
})();
