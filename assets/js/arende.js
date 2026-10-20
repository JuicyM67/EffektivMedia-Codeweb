/* Ärenden: formuläret på /arende och kundens ärendesida /arende/<token>.
   Webbläsaren pratar bara med vår egen server (/api/arende/*), aldrig med Inkio.
   Allt som kunder och handläggare skrivit sätts med textContent, aldrig som HTML. */
(function () {
    "use strict";

    var ALLOWED = ["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf", "doc", "docx", "xls", "xlsx", "txt", "csv"];
    var MAX_FILES = 5;
    var MAX_FILE = 10 * 1024 * 1024;
    // Vercel tar emot högst 4,5 MB per anrop, inklusive text och multipart-overhead.
    var MAX_TOTAL = 4 * 1024 * 1024;
    // Större foton skalas ner i webbläsaren så att de ryms.
    var SHRINK_OVER = 1024 * 1024;
    var SHRINK_MAX_SIDE = 2000;
    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var NETWORK_ERROR = "Vi kunde inte nå servern. Kontrollera din internetanslutning och försök igen.";
    var TOO_LARGE = "Filerna är för stora. Bifoga högst 4 MB totalt.";

    function $(id) {
        return document.getElementById(id);
    }

    function svg(paths) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    var ICON_FILE = svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>');
    var ICON_CLIP = svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>');
    var ICON_X = svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>');

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

    function formatDate(iso, withTime) {
        var date = new Date(iso);
        if (isNaN(date.getTime())) return "";
        var options = { timeZone: "Europe/Stockholm", day: "numeric", month: "short", year: "numeric" };
        if (withTime) {
            options.hour = "2-digit";
            options.minute = "2-digit";
        }
        return date.toLocaleString("sv-SE", options);
    }

    function initials(name) {
        var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return "?";
        return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
    }

    /** Fetch-svar som { ok, status, data }. Fel från Vercel kan vara HTML i stället för JSON. */
    function asJson(response) {
        return response.json().catch(function () {
            return null;
        }).then(function (data) {
            return { ok: response.ok, status: response.status, data: data || {} };
        });
    }

    function setBusy(button, busy, busyText) {
        var label = button.querySelector(".text-btn");
        if (!button.getAttribute("data-label")) button.setAttribute("data-label", label.textContent);
        if (busy) {
            button.setAttribute("disabled", "disabled");
            button.setAttribute("aria-busy", "true");
            label.innerHTML = '<span class="arende-spinner" aria-hidden="true"></span>';
            label.appendChild(document.createTextNode(busyText));
        } else {
            button.removeAttribute("disabled");
            button.removeAttribute("aria-busy");
            label.textContent = button.getAttribute("data-label");
        }
    }

    function showAlert(box, textNode, message) {
        if (!message) {
            box.hidden = true;
            return;
        }
        textNode.textContent = message;
        box.hidden = false;
    }

    function scrollToEl(node) {
        var top = node.getBoundingClientRect().top + window.pageYOffset - 130;
        window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
    }

    function initCounters(scope) {
        var counters = [];
        Array.prototype.forEach.call(scope.querySelectorAll("[data-counter-for]"), function (counter) {
            var field = $(counter.getAttribute("data-counter-for"));
            if (!field) return;
            var max = parseInt(field.getAttribute("maxlength"), 10);
            var update = function () {
                counter.textContent = field.value.length.toLocaleString("sv-SE") + " / " + max.toLocaleString("sv-SE");
            };
            field.addEventListener("input", update);
            update();
            counters.push(update);
        });
        return function refresh() {
            counters.forEach(function (update) {
                update();
            });
        };
    }

    function markInvalid(field, invalid) {
        if (!field) return;
        field.classList.toggle("is-invalid", invalid);
        Array.prototype.forEach.call(field.querySelectorAll("input:not([type=radio]), textarea"), function (input) {
            if (invalid) input.setAttribute("aria-invalid", "true");
            else input.removeAttribute("aria-invalid");
        });
    }

    /* ---------- Bilder skalas ner så att de ryms inom gränsen ---------- */
    function shrink(file) {
        if (file.size <= SHRINK_OVER || !/^image\/(jpeg|png|webp)$/.test(file.type) || !window.URL || !HTMLCanvasElement.prototype.toBlob) {
            return Promise.resolve(file);
        }
        return new Promise(function (resolve) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                var scale = Math.min(1, SHRINK_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
                var canvas = document.createElement("canvas");
                canvas.width = Math.round(img.naturalWidth * scale);
                canvas.height = Math.round(img.naturalHeight * scale);
                var ctx = canvas.getContext("2d");
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                canvas.toBlob(function (blob) {
                    if (!blob || blob.size >= file.size) return resolve(file);
                    var name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
                    try {
                        resolve(new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified }));
                    } catch (e) {
                        blob.name = name;
                        resolve(blob);
                    }
                }, "image/jpeg", 0.85);
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                resolve(file);
            };
            img.src = url;
        });
    }

    /* ---------- Filväljare med dra-och-släpp ---------- */
    function FilePicker(field) {
        var input = field.querySelector("input[type=file]");
        var drop = field.querySelector("[data-drop]");
        var list = field.querySelector("[data-file-list]");
        var error = field.querySelector("[data-file-error]");
        var files = [];
        var pending = 0;

        function setError(message) {
            error.textContent = message || "";
            field.classList.toggle("is-invalid", Boolean(message));
        }

        function total() {
            return files.reduce(function (sum, f) {
                return sum + f.size;
            }, 0);
        }

        function render() {
            list.innerHTML = "";
            files.forEach(function (file, index) {
                var item = el("li", "arende-file");
                var icon = el("span", "arende-file-icon");
                icon.innerHTML = ICON_FILE;
                var remove = el("button", "arende-file-remove");
                remove.type = "button";
                remove.setAttribute("aria-label", "Ta bort " + file.name);
                remove.innerHTML = ICON_X;
                remove.addEventListener("click", function () {
                    files.splice(index, 1);
                    setError("");
                    render();
                    input.focus();
                });
                item.appendChild(icon);
                item.appendChild(el("span", "arende-file-name", file.name));
                item.appendChild(el("span", "arende-file-size", formatBytes(file.size)));
                item.appendChild(remove);
                list.appendChild(item);
            });
        }

        function add(fileList) {
            setError("");
            Array.prototype.forEach.call(fileList, function (file) {
                if (files.length + pending >= MAX_FILES) {
                    setError("Du kan bifoga högst " + MAX_FILES + " filer.");
                    return;
                }
                if (ALLOWED.indexOf(extension(file.name)) === -1) {
                    setError(file.name + " kan inte bifogas. Skicka bilder, PDF, Word, Excel, text eller CSV.");
                    return;
                }
                pending++;
                shrink(file).then(function (ready) {
                    pending--;
                    if (ready.size > MAX_FILE) {
                        setError(file.name + " är större än 10 MB.");
                    } else if (total() + ready.size > MAX_TOTAL) {
                        setError(file.name + " får inte plats – filerna får vara högst 4 MB tillsammans.");
                    } else {
                        files.push(ready);
                    }
                    render();
                });
            });
            input.value = "";
        }

        input.addEventListener("change", function () {
            add(input.files);
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
            if (event.dataTransfer && event.dataTransfer.files) add(event.dataTransfer.files);
        });

        return {
            files: function () {
                return files.slice();
            },
            busy: function () {
                return pending > 0;
            },
            reset: function () {
                files = [];
                setError("");
                render();
            }
        };
    }

    /* =====================================================================
       /arende – skapa ärende
       ===================================================================== */
    function initCreateForm(form) {
        var typeGroup = $("arendeTypeGroup");
        var typesBox = $("arendeTypes");
        var typesLoading = $("arendeTypesLoading");
        var typeField = $("field-request_type");
        var message = $("arende-message");
        var alertBox = $("arendeAlert");
        var alertText = $("arendeAlertText");
        var submit = $("arendeSubmit");
        var success = $("arendeSuccess");
        var companyToggle = $("arende-is-company");
        var companyBox = $("arendeCompany");
        var picker = FilePicker($("field-files"));
        var refreshCounters = initCounters(form);
        var typesRequired = false;

        function numberGroups() {
            var n = 0;
            Array.prototype.forEach.call(form.querySelectorAll(".arende-group"), function (group) {
                var legend = group.querySelector(".arende-group-title");
                if (!legend.getAttribute("data-title")) legend.setAttribute("data-title", legend.textContent.replace(/^\d+\.\s*/, ""));
                if (!group.hidden) legend.textContent = ++n + ". " + legend.getAttribute("data-title");
            });
        }

        function skipTypes() {
            typeGroup.hidden = true;
            typesRequired = false;
            numberGroups();
        }

        function selectedType() {
            var checked = typesBox.querySelector("input:checked");
            return checked ? checked.value : "";
        }

        // Ärendetyperna styr vilken avdelning ärendet hamnar hos i Inkio.
        fetch("/api/arende/typer", { credentials: "same-origin" })
            .then(asJson)
            .then(function (result) {
                var types = result.data.types || [];
                typesLoading.hidden = true;
                // En tom lista betyder att allt går till standardavdelningen. Kunde listan
                // inte hämtas låter vi Inkio avgöra och visar dess felmeddelande vid behov.
                if (!result.ok || !types.length) return skipTypes();
                types.forEach(function (type, index) {
                    var wrap = el("div", "arende-type");
                    var input = el("input");
                    input.type = "radio";
                    input.name = "request_type";
                    input.value = type.id;
                    input.id = "arende-typ-" + index;
                    var label = el("label");
                    label.setAttribute("for", input.id);
                    var text = el("span", "arende-type-text");
                    text.appendChild(el("span", "arende-type-title", type.title));
                    if (type.hint) text.appendChild(el("span", "arende-type-hint", type.hint));
                    label.appendChild(text);
                    wrap.appendChild(input);
                    wrap.appendChild(label);
                    typesBox.appendChild(wrap);
                });
                if (types.length === 1) typesBox.querySelector("input").checked = true;
                typesBox.hidden = false;
                typesRequired = true;
            })
            .catch(function () {
                typesLoading.hidden = true;
                skipTypes();
            });

        typesBox.addEventListener("change", function () {
            markInvalid(typeField, false);
        });

        companyToggle.addEventListener("change", function () {
            companyBox.hidden = !companyToggle.checked;
            companyToggle.setAttribute("aria-expanded", String(companyToggle.checked));
            if (companyToggle.checked) $("arende-company").focus();
        });

        // Ta bort felmarkeringen så fort användaren rättar fältet.
        Array.prototype.forEach.call(form.querySelectorAll(".arende-field input, .arende-field textarea"), function (input) {
            input.addEventListener("input", function () {
                var field = input.closest(".arende-field");
                if (field && field.classList.contains("is-invalid") && field.id !== "field-files") markInvalid(field, false);
            });
        });

        function validate() {
            var checks = [
                [typeField, !typesRequired || Boolean(selectedType()), typesBox.querySelector("input")],
                [$("field-subject"), $("arende-subject").value.trim() !== "", $("arende-subject")],
                [$("field-message"), message.value.trim() !== "", message],
                [$("field-name"), $("arende-name").value.trim() !== "", $("arende-name")],
                [$("field-email"), EMAIL_PATTERN.test($("arende-email").value.trim()), $("arende-email")]
            ];
            var first = null;
            checks.forEach(function (check) {
                markInvalid(check[0], !check[1]);
                if (!check[1] && !first) first = check[2];
            });
            return first;
        }

        function ticketPath(url) {
            try {
                var match = /^\/arende\/([0-9a-f]{32})$/i.exec(new URL(url, window.location.href).pathname);
                return match ? "/arende/" + match[1].toLowerCase() : "";
            } catch (e) {
                return "";
            }
        }

        function showSuccess(data, email) {
            var path = data.url ? ticketPath(data.url) : "";
            $("arendeNumber").textContent = data.number || "";
            $("arendeNumberWrap").hidden = !data.number;
            $("arendeSuccessEmail").textContent = email;
            $("arendeLink").hidden = !path;
            if (path) $("arendeLink").setAttribute("href", path);
            form.hidden = true;
            success.hidden = false;
            success.focus({ preventScroll: true });
            scrollToEl(success.parentNode);
        }

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            showAlert(alertBox, alertText, "");

            if (picker.busy()) {
                showAlert(alertBox, alertText, "Vänta ett ögonblick – vi förbereder dina filer.");
                return;
            }
            var invalid = validate();
            if (invalid) {
                invalid.focus();
                return;
            }

            var data = new FormData();
            ["name", "email", "phone", "subject", "message", "website"].forEach(function (name) {
                data.append(name, form.elements[name].value.trim());
            });
            if (companyToggle.checked) {
                data.append("company", form.elements.company.value.trim());
                data.append("org_number", form.elements.org_number.value.trim());
            }
            if (selectedType()) data.append("request_type", selectedType());
            picker.files().forEach(function (file) {
                data.append("files", file, file.name);
            });

            var email = form.elements.email.value.trim();
            setBusy(submit, true, "Skickar…");
            fetch("/api/arende/skapa", { method: "POST", body: data, credentials: "same-origin" })
                .then(asJson)
                .then(function (result) {
                    if (result.ok && result.data.ok) return showSuccess(result.data, email);
                    var text = result.status === 413 ? TOO_LARGE : result.data.error || "Något gick fel. Försök igen om en stund.";
                    showAlert(alertBox, alertText, text);
                    scrollToEl(alertBox);
                })
                .catch(function () {
                    showAlert(alertBox, alertText, NETWORK_ERROR);
                    scrollToEl(alertBox);
                })
                .then(function () {
                    setBusy(submit, false);
                });
        });

        // "Skapa ett nytt ärende": töm ärendet men behåll kontaktuppgifterna.
        $("arendeNew").addEventListener("click", function () {
            var keep = ["name", "email", "phone", "company", "org_number"].map(function (name) {
                return [name, form.elements[name].value];
            });
            var isCompany = companyToggle.checked;
            form.reset();
            keep.forEach(function (pair) {
                form.elements[pair[0]].value = pair[1];
            });
            companyToggle.checked = isCompany;
            picker.reset();
            refreshCounters();
            success.hidden = true;
            form.hidden = false;
            scrollToEl(form);
            var firstType = typesBox.querySelector("input");
            (typesRequired && firstType ? firstType : $("arende-subject")).focus({ preventScroll: true });
        });
    }

    /* =====================================================================
       /arende/<token> – kundens ärendesida
       ===================================================================== */
    var STATUS = {
        Open: {
            label: "Öppet",
            cls: "is-open",
            text: "Vi arbetar med ditt ärende. Du får ett mejl så fort vi har svarat."
        },
        Solved: {
            label: "Löst",
            cls: "is-solved",
            text: "Ärendet är markerat som löst. Behöver du mer hjälp kan du fortfarande skriva här. Det stängs automatiskt 7 dagar efter att det löstes."
        },
        Closed: {
            label: "Stängt",
            cls: "is-closed",
            text: "Ärendet är avslutat. Behöver du mer hjälp kan du skapa ett nytt ärende."
        }
    };
    var CHANNEL = { Email: "via e-post", Portal: "via ärendesidan" };

    function initTicketPage(view) {
        var match = /^\/arende\/([0-9a-f]{32})\/?$/i.exec(window.location.pathname);
        var token = match ? match[1].toLowerCase() : "";
        var loading = $("ticketLoading");
        var state = $("ticketState");
        var thread = $("ticketThread");
        var replyForm = $("replyForm");
        var replyMessage = $("replyMessage");
        var replyField = $("field-reply");
        var replyAlert = $("replyAlert");
        var replyAlertText = $("replyAlertText");
        var replySubmit = $("replySubmit");
        var solveBtn = $("solveBtn");
        var solveConfirm = $("solveConfirm");
        var picker = FilePicker($("field-reply-files"));
        var refreshCounters = initCounters(replyForm);
        var rendered = false;
        var lastLoad = 0;
        var toastTimer = null;

        function toast(text) {
            var box = $("arendeToast");
            $("arendeToastText").textContent = text;
            box.classList.add("is-visible");
            clearTimeout(toastTimer);
            toastTimer = setTimeout(function () {
                box.classList.remove("is-visible");
            }, 4500);
        }

        function api(path, options) {
            options = options || {};
            options.headers = { "X-Arende-Token": token };
            options.cache = "no-store";
            options.credentials = "same-origin";
            return fetch(path, options).then(asJson);
        }

        function showState(notFound, message) {
            loading.hidden = true;
            view.hidden = true;
            state.hidden = false;
            if (notFound) {
                document.title = "Ärendet hittades inte – Effektiv Media";
                $("ticketTitle").textContent = "Ärendet hittades inte";
            } else {
                $("ticketStateTitle").textContent = "Ärendet kunde inte visas just nu";
                $("ticketStateText").textContent = message || "Försök igen om en liten stund. Du kan också svara direkt på mejlet du fick från oss.";
            }
        }

        function setStatus(node, status) {
            node.textContent = status.label;
            node.className = "ticket-status " + status.cls;
        }

        function attachmentList(files) {
            var wrap = el("div", "ticket-attachments");
            files.forEach(function (file) {
                var link = el("a", "ticket-attachment");
                link.href = "/arende/" + token + "/fil/" + encodeURIComponent(file.id);
                link.setAttribute("download", "");
                link.setAttribute("rel", "nofollow noopener");
                link.innerHTML = ICON_CLIP;
                link.appendChild(el("span", "", file.name));
                if (file.size) link.appendChild(el("small", "", formatBytes(file.size)));
                link.setAttribute("aria-label", "Ladda ner " + file.name);
                wrap.appendChild(link);
            });
            return wrap;
        }

        function message(m) {
            var item = el("li", "ticket-msg " + (m.fromCustomer ? "is-customer" : "is-company") + (m.first ? " ticket-msg-first" : ""));
            var avatar = el("span", "ticket-avatar");
            avatar.setAttribute("aria-hidden", "true");
            if (m.fromCustomer) {
                avatar.textContent = initials(m.author);
            } else {
                var logo = el("img");
                logo.src = "/assets/images/logo/effektivmedia-mark-badge.png";
                logo.alt = "";
                avatar.appendChild(logo);
            }
            var bubble = el("div", "ticket-bubble");
            if (m.first) bubble.appendChild(el("span", "ticket-msg-label", "Ditt ärende"));
            var head = el("div", "ticket-msg-head");
            head.appendChild(el("span", "ticket-msg-author", m.author || (m.fromCustomer ? "Du" : "Effektiv Media")));
            if (!m.fromCustomer) head.appendChild(el("span", "ticket-msg-tag", "Effektiv Media"));
            var when = formatDate(m.createdAt, true);
            if (m.fromCustomer && CHANNEL[m.channel]) when += " · " + CHANNEL[m.channel];
            var time = el("time", "ticket-msg-time", when);
            time.setAttribute("datetime", m.createdAt || "");
            head.appendChild(time);
            bubble.appendChild(head);
            bubble.appendChild(el("div", "ticket-msg-body", m.content || ""));
            if (m.attachments && m.attachments.length) bubble.appendChild(attachmentList(m.attachments));
            item.appendChild(avatar);
            item.appendChild(bubble);
            return item;
        }

        function render(t, scrollToLast) {
            var status = STATUS[t.status] || { label: t.status, cls: "is-open", text: "" };
            rendered = true;
            loading.hidden = true;
            state.hidden = true;
            view.hidden = false;

            document.title = "Ärende " + t.number + " – Effektiv Media";
            $("ticketTitle").textContent = t.subject;
            $("ticketCrumb").textContent = t.number;
            $("ticketHeroNumber").textContent = t.number;
            $("ticketHeroDate").textContent = "Skapat " + formatDate(t.createdAt);
            setStatus($("ticketHeroStatus"), status);
            $("ticketHeroMeta").hidden = false;

            setStatus($("asideStatus"), status);
            $("asideStatusText").textContent = status.text;
            $("factNumber").textContent = t.number;
            $("factCreated").textContent = formatDate(t.createdAt, true);
            $("factModified").textContent = formatDate(t.modifiedAt, true);

            thread.innerHTML = "";
            thread.appendChild(message({
                first: true,
                fromCustomer: true,
                author: t.contactName,
                content: t.description,
                attachments: t.attachments,
                createdAt: t.createdAt
            }));
            t.messages.forEach(function (m) {
                thread.appendChild(message(m));
            });
            if (!t.messages.length && t.status === "Open") {
                thread.appendChild(el("li", "ticket-divider", "Vi har tagit emot ditt ärende och återkommer så snart vi kan"));
            }

            $("ticketReply").hidden = !t.canReply;
            $("ticketClosed").hidden = t.canReply;
            $("ticketSolve").hidden = !t.canSolve;
            solveBtn.hidden = false;
            solveConfirm.hidden = true;

            if (scrollToLast && thread.lastElementChild) scrollToEl(thread.lastElementChild);
        }

        function load(scrollToLast) {
            return api("/api/arende/hamta")
                .then(function (result) {
                    lastLoad = Date.now();
                    if (result.ok && result.data.ok) return render(result.data.ticket, scrollToLast);
                    if (result.status === 404) return showState(true);
                    if (!rendered) showState(false, result.data.error);
                })
                .catch(function () {
                    if (!rendered) showState(false);
                });
        }

        if (!token) return showState(true);
        load(false);

        // Hämta om ärendet när kunden kommer tillbaka till fliken, så att nya svar syns.
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible" && rendered && Date.now() - lastLoad > 60000) load(false);
        });

        replyMessage.addEventListener("input", function () {
            if (replyField.classList.contains("is-invalid")) markInvalid(replyField, false);
        });

        replyForm.addEventListener("submit", function (event) {
            event.preventDefault();
            showAlert(replyAlert, replyAlertText, "");
            if (picker.busy()) {
                showAlert(replyAlert, replyAlertText, "Vänta ett ögonblick – vi förbereder dina filer.");
                return;
            }
            var text = replyMessage.value.trim();
            var files = picker.files();
            if (!text && !files.length) {
                markInvalid(replyField, true);
                replyMessage.focus();
                return;
            }
            var data = new FormData();
            data.append("message", text);
            files.forEach(function (file) {
                data.append("files", file, file.name);
            });

            setBusy(replySubmit, true, "Skickar…");
            api("/api/arende/svara", { method: "POST", body: data })
                .then(function (result) {
                    if (result.ok && result.data.ok) {
                        replyForm.reset();
                        picker.reset();
                        refreshCounters();
                        toast("Ditt svar är skickat");
                        return load(true);
                    }
                    showAlert(replyAlert, replyAlertText, result.status === 413 ? TOO_LARGE : result.data.error || "Ditt svar kunde inte skickas. Försök igen.");
                })
                .catch(function () {
                    showAlert(replyAlert, replyAlertText, NETWORK_ERROR);
                })
                .then(function () {
                    setBusy(replySubmit, false);
                });
        });

        solveBtn.addEventListener("click", function () {
            solveBtn.hidden = true;
            solveConfirm.hidden = false;
            $("solveYes").focus();
        });
        $("solveNo").addEventListener("click", function () {
            solveConfirm.hidden = true;
            solveBtn.hidden = false;
            solveBtn.focus();
        });
        $("solveYes").addEventListener("click", function () {
            var yes = $("solveYes");
            setBusy(yes, true, "Sparar…");
            api("/api/arende/lost", { method: "POST" })
                .then(function (result) {
                    if (result.ok && result.data.ok) {
                        toast("Tack! Ärendet är markerat som löst.");
                        return load(false);
                    }
                    toast(result.data.error || "Det gick inte att markera ärendet som löst. Försök igen.");
                })
                .catch(function () {
                    toast(NETWORK_ERROR);
                })
                .then(function () {
                    setBusy(yes, false);
                });
        });
    }

    var createForm = $("arendeForm");
    if (createForm) initCreateForm(createForm);
    var ticketView = $("ticketView");
    if (ticketView) initTicketPage(ticketView);
})();
