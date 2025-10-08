function setCookie(name, value, days) {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(";");
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) == " ") c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

let currentTheme = getCookie("theme") || "system";
const themes = ["light", "dark", "system"];
let themeIndex = themes.indexOf(currentTheme);
if (themeIndex === -1) themeIndex = 0;

function toggleTheme() {
  themeIndex = (themeIndex + 1) % themes.length;
  currentTheme = themes[themeIndex];
  setCookie("theme", currentTheme, 365);
  applyTheme();
}

function applyTheme() {
  const body = document.body;
  const logo = document.getElementById("logo");
  const themeIcon = document.getElementById("theme-icon");

  if (currentTheme === "system") {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    body.setAttribute("data-theme", prefersDark ? "dark" : "light");
    // Monitor/Screen icon for system mode
    themeIcon.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
  } else {
    body.setAttribute("data-theme", currentTheme);
    if (currentTheme === "dark") {
      // Sun icon for dark mode
      themeIcon.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/></svg>';
    } else {
      // Moon icon for light mode
      themeIcon.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    }
  }

  // Update logo based on theme
  const isDark = body.getAttribute("data-theme") === "dark";
  logo.src = isDark
    ? "https://ik.imagekit.io/dployr/shared/logo-secondary.svg?updatedAt=1751365002381"
    : "https://ik.imagekit.io/dployr/shared/logo.svg?updatedAt=1751365002259";
}

// Listen for system theme changes
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (currentTheme === "system") {
      applyTheme();
    }
  });

// Initialize theme
applyTheme();

// Mobile menu toggle
function toggleMobileMenu() {
  const mobileMenu = document.getElementById("mobile-menu");
  mobileMenu.classList.toggle("show");
}

function openContactForm() {
  document.getElementById('contactModal').classList.add('show');
  // Close mobile menu if open
  document.getElementById('mobile-menu').classList.remove('show');
}

function closeContactForm() {
  document.getElementById('contactModal').classList.remove('show');
}

// Close modal when clicking outside
document.getElementById('contactModal').addEventListener('click', function(e) {
  if (e.target === this) {
      closeContactForm();
  }
});

// Handle form submission
document.querySelector('.contact-form').addEventListener('submit', function(e) {
  e.preventDefault();
  
  // Get form data
  const formData = new FormData(this);
  const data = Object.fromEntries(formData);
  
  // Here you would typically send the data to your server
  console.log('Contact form data:', data);
  
  // For now, just show an alert and close the form
  alert('Thank you for your message! We\'ll get back to you soon.');
  closeContactForm();
  this.reset();
});
