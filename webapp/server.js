const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json'); // only sellers stored here
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const LOGS_PATH = path.join(DATA_DIR, 'logs.json');

// Ensure data files exist
function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
  }
}
ensureFile(USERS_PATH, []);
ensureFile(PRODUCTS_PATH, []);
ensureFile(LOGS_PATH, []);

// Helpers to read/write JSON safely
function readJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || 'null');
  } catch (err) {
    console.error('Failed to read JSON', filePath, err);
    return null;
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write JSON', filePath, err);
  }
}

// View engine and middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'very_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 6 },
  })
);

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: function (req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage });

// Auth helpers
function isAuthenticated(req) {
  return !!req.session.user;
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return function (req, res, next) {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send('Unauthorized');
    }
    next();
  };
}

// Routes
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'seller') return res.redirect('/seller');
  }
  res.redirect('/login');
});

// Login & Register
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password, role } = req.body;

  // Admin fixed credentials
  if (role === 'admin') {
    if (username === 'Amir112233' && password === 'Amir112233') {
      req.session.user = { id: 'admin', username, role: 'admin' };
      return res.redirect('/admin');
    }
    return res.render('login', { error: 'نام کاربری یا گذرواژه مدیریت نادرست است.' });
  }

  // Seller login
  const users = readJson(USERS_PATH) || [];
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.render('login', { error: 'کاربر یافت نشد.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.render('login', { error: 'گذرواژه نادرست است.' });
  }

  req.session.user = { id: user.id, username: user.username, role: 'seller' };
  res.redirect('/seller');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  try {
    const { username, password, fullname } = req.body;
    if (!username || !password || !fullname) {
      return res.render('register', { error: 'تمام فیلدها الزامی است.' });
    }

    const users = readJson(USERS_PATH) || [];
    const exists = users.some((u) => u.username === username);
    if (exists) {
      return res.render('register', { error: 'این نام کاربری قبلاً ثبت شده است.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      username,
      fullname,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    writeJson(USERS_PATH, users);

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'خطا در ثبت‌نام. دوباره تلاش کنید.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Admin dashboard
app.get('/admin', requireAuth, requireRole('admin'), (req, res) => {
  const products = readJson(PRODUCTS_PATH) || [];
  const users = readJson(USERS_PATH) || [];
  const logs = readJson(LOGS_PATH) || [];

  // Aggregate logs per seller
  const logsBySellerId = users.map((u) => ({
    seller: u,
    logs: logs.filter((l) => l.sellerId === u.id).sort((a, b) => (a.date < b.date ? 1 : -1)),
  }));

  res.render('admin', {
    user: req.session.user,
    products,
    logsBySellerId,
  });
});

app.post(
  '/admin/products',
  requireAuth,
  requireRole('admin'),
  upload.array('images', 5),
  (req, res) => {
    const { title, description, price } = req.body;
    const files = req.files || [];

    if (!title || !price) {
      return res.status(400).send('عنوان و قیمت الزامی است.');
    }

    const products = readJson(PRODUCTS_PATH) || [];

    const newProduct = {
      id: uuidv4(),
      title,
      description: description || '',
      price: Number(price),
      images: files.map((f) => `/public/uploads/${path.basename(f.path)}`),
      createdAt: new Date().toISOString(),
    };

    products.push(newProduct);
    writeJson(PRODUCTS_PATH, products);

    res.redirect('/admin');
  }
);

// Seller dashboard
app.get('/seller', requireAuth, requireRole('seller'), (req, res) => {
  const products = readJson(PRODUCTS_PATH) || [];
  const logs = readJson(LOGS_PATH) || [];
  const myLogs = logs
    .filter((l) => l.sellerId === req.session.user.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.render('seller', {
    user: req.session.user,
    products,
    myLogs,
    error: null,
  });
});

app.post('/seller/logs', requireAuth, requireRole('seller'), (req, res) => {
  const { date, workingHours, activityLevel, salesAmount, productType, notes } = req.body;

  if (!date || !workingHours || !salesAmount || !productType) {
    const products = readJson(PRODUCTS_PATH) || [];
    const logs = readJson(LOGS_PATH) || [];
    const myLogs = logs
      .filter((l) => l.sellerId === req.session.user.id)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return res.status(400).render('seller', {
      user: req.session.user,
      products,
      myLogs,
      error: 'تاریخ، ساعات کاری، میزان فروش و نوع محصول الزامی است.',
    });
  }

  const logs = readJson(LOGS_PATH) || [];
  const newLog = {
    id: uuidv4(),
    sellerId: req.session.user.id,
    date,
    workingHours: Number(workingHours),
    activityLevel: activityLevel || '',
    salesAmount: Number(salesAmount),
    productType,
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };

  logs.push(newLog);
  writeJson(LOGS_PATH, logs);

  res.redirect('/seller');
});

// Admin seller detail
app.get('/admin/sellers/:id', requireAuth, requireRole('admin'), (req, res) => {
  const sellerId = req.params.id;
  const users = readJson(USERS_PATH) || [];
  const seller = users.find((u) => u.id === sellerId);
  if (!seller) return res.status(404).send('فروشنده یافت نشد');

  const logs = (readJson(LOGS_PATH) || [])
    .filter((l) => l.sellerId === sellerId)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.render('admin_seller_detail', { user: req.session.user, seller, logs });
});

// Direct download routes
app.get('/download/webapp-full.zip', (req, res) => {
  const zipPath = path.join(__dirname, '..', 'webapp-full.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('فایل یافت نشد');
  res.download(zipPath, 'webapp-full.zip');
});

app.get('/download/webapp.zip', (req, res) => {
  const zipPath = path.join(__dirname, '..', 'webapp.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('فایل یافت نشد');
  res.download(zipPath, 'webapp.zip');
});

// 404
app.use((req, res) => {
  res.status(404).send('Route not found.');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});