/* ═══════════════════════════════════════════════════════════
   js/inquiry-popup.js — 문의하기 모달 + 실제 API 저장 최종본
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('inquiry-modal');
    var form = document.getElementById('inquiry-form');

    if (!modal || !form) return;

    var openButtons = Array.from(document.querySelectorAll(
      '#inquiry-float-btn, [data-inquiry-open]'
    ));

    var closeButtons = Array.from(modal.querySelectorAll(
      '.inquiry-modal-close, [data-inquiry-close], .modal-close, [aria-label="닫기"]'
    ));

    var cancelButtons = Array.from(modal.querySelectorAll(
      '.inquiry-btn-cancel, [data-inquiry-cancel], .cancel-btn'
    ));

    var backdrop = modal.querySelector('.inquiry-modal-backdrop, .modal-backdrop');

    var elCategory = document.getElementById('inquiry-category');
    var elName = document.getElementById('inquiry-name');
    var elEmail = document.getElementById('inquiry-email');
    var elPhone = document.getElementById('inquiry-phone');
    var elTitle = document.getElementById('inquiry-title');
    var elMessage = document.getElementById('inquiry-message');
    var elAgree = document.getElementById('inquiry-agree');
    var submitBtn = form.querySelector('button[type="submit"]');

    var isSubmitting = false;

    function toast(type, message) {
      if (window.Feedback && typeof window.Feedback[type] === 'function') {
        window.Feedback[type](message);
        return;
      }
      if (type === 'error') {
        alert(message);
      } else {
        alert(message);
      }
    }

    function trim(v) {
      return String(v || '').trim();
    }

    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function setSubmitting(flag) {
      isSubmitting = !!flag;
      if (!submitBtn) return;

      submitBtn.disabled = isSubmitting;
      submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
      submitBtn.textContent = isSubmitting ? '접수 중...' : submitBtn.dataset.originalText;
    }

    function openModal() {
      modal.classList.add('is-open');
      modal.style.display = 'block';
      document.body.style.overflow = 'hidden';

      prefillUserInfo();

      setTimeout(function () {
        if (elName && !elName.value) elName.focus();
        else if (elTitle) elTitle.focus();
      }, 30);
    }

    function closeModal() {
      if (isSubmitting) return;

      modal.classList.remove('is-open');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }

    async function prefillUserInfo() {
      try {
        var user = null;

        if (window.PublicAuth && typeof window.PublicAuth.getUser === 'function') {
          user = window.PublicAuth.getUser();
        }

        if (window.PublicAuth &&
            typeof window.PublicAuth.isLoggedIn === 'function' &&
            window.PublicAuth.isLoggedIn() &&
            typeof window.PublicAuth.getMe === 'function') {
          try {
            var me = await window.PublicAuth.getMe();
            if (me && typeof me === 'object') user = me;
          } catch (e) {
            // getMe 실패해도 localStorage 유저 정보로 계속 진행
          }
        }

        if (!user) return;

        if (elName && !trim(elName.value)) {
          elName.value = user.name || user.nickname || '';
        }

        if (elEmail && !trim(elEmail.value)) {
          elEmail.value = user.email || '';
        }

        if (elPhone && !trim(elPhone.value)) {
          elPhone.value = user.phone || user.mobile || '';
        }
      } catch (err) {
        // 프리필 실패는 치명적 아님
      }
    }

    function getPayload() {
      return {
        category: trim(elCategory ? elCategory.value : '') || 'general',
        name: trim(elName ? elName.value : ''),
        email: trim(elEmail ? elEmail.value : ''),
        phone: trim(elPhone ? elPhone.value : ''),
        title: trim(elTitle ? elTitle.value : ''),
        message: trim(elMessage ? elMessage.value : ''),
        agree: !!(elAgree && elAgree.checked),
        pageUrl: window.location.href,
        referrer: document.referrer || ''
      };
    }

    function validate(payload) {
      if (!payload.name) {
        toast('error', '이름을 입력해주세요.');
        if (elName) elName.focus();
        return false;
      }

      if (!payload.email) {
        toast('error', '이메일을 입력해주세요.');
        if (elEmail) elEmail.focus();
        return false;
      }

      if (!isValidEmail(payload.email)) {
        toast('error', '올바른 이메일 형식을 입력해주세요.');
        if (elEmail) elEmail.focus();
        return false;
      }

      if (!payload.title) {
        toast('error', '제목을 입력해주세요.');
        if (elTitle) elTitle.focus();
        return false;
      }

      if (!payload.message) {
        toast('error', '문의 내용을 입력해주세요.');
        if (elMessage) elMessage.focus();
        return false;
      }

      if (!payload.agree) {
        toast('error', '개인정보 수집 및 이용 동의가 필요합니다.');
        if (elAgree) elAgree.focus();
        return false;
      }

      return true;
    }

    async function handleSubmit(e) {
      e.preventDefault();
      if (isSubmitting) return;

      if (!window.PublicAPI || typeof window.PublicAPI.createInquiry !== 'function') {
        toast('error', '문의 API가 연결되지 않았습니다. public-api.js를 확인해주세요.');
        return;
      }

      var payload = getPayload();

      if (!validate(payload)) return;

      try {
        setSubmitting(true);

        await window.PublicAPI.createInquiry(payload);

        toast('success', '문의가 정상 접수되었습니다.');

        form.reset();

        if (elCategory) elCategory.value = 'general';

        await prefillUserInfo();

        setTimeout(function () {
          closeModal();
        }, 200);
      } catch (err) {
        var msg = '문의 접수 중 오류가 발생했습니다.';
        if (err && err.message) msg = err.message;
        toast('error', msg);
      } finally {
        setSubmitting(false);
      }
    }

    openButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        openModal();
      });
    });

    closeButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        closeModal();
      });
    });

    cancelButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        closeModal();
      });
    });

    if (backdrop) {
      backdrop.addEventListener('click', closeModal);
    }

    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) {
        closeModal();
      }
    });

    form.addEventListener('submit', handleSubmit);

    prefillUserInfo();
  });
})();
