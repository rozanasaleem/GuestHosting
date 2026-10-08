# دليل الضيوف

تطبيق ويب للبحث في قائمة الضيوف وتصفيتها حسب المجال والمنطقة والنص الحر، مع حفظ التعديلات والإضافات من خلال API متصل بـ Supabase. عند التشغيل المحلي بدون Supabase يستخدم SQLite كخطة احتياطية للتجربة فقط.

## التشغيل المحلي

ثبّت الاعتماديات ثم شغّل الخادم:

```bash
python3 -m pip install -r requirements.txt
```

```bash
python3 server.py --host 127.0.0.1 --port 8080
```

ثم افتح:

```text
http://127.0.0.1:8080
```

بدون متغيرات Supabase سيحفظ محلياً في `guests.db`. لا تستخدم SQLite للإنتاج على Vercel.

## إعداد Supabase

1. افتح Supabase SQL Editor.
2. شغّل محتوى `supabase_schema.sql`.
3. افتح Table Editor > `guests`.
4. استورد `guests_supabase.csv`.
5. تأكد أن الأعمدة مستوردة كالتالي:

```text
name
title
phone_number
category
region
phone_notes
```

اترك الأعمدة الأخرى مثل `id`, `status`, `notes`, `custom_json`, و`source` لتأخذ القيم الافتراضية. يجب أن يبقى `phone_number` من نوع `text` حتى لا تضيع الأصفار في بداية الرقم.

## النشر على Vercel

ارفع المشروع إلى GitHub ثم اربطه في Vercel. Vercel سيقرأ `requirements.txt` ويشغّل `server.py` كتطبيق Flask.

أضف هذه المتغيرات في Vercel Project Settings > Environment Variables:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_GUESTS_TABLE=guests
SUPABASE_FIELDS_TABLE=custom_fields
```

مهم: استخدم `service_role` في Vercel فقط. لا تضع هذا المفتاح داخل JavaScript في المتصفح ولا تنشره في GitHub.

## التشغيل كملف مباشر

يمكن فتح `index.html` مباشرة في المتصفح للتجربة. في هذه الحالة يمكن البحث والتعديل والإضافة، لكن التعديلات تحفظ محلياً في نفس المتصفح فقط، وليست داخل Supabase.

## ما الذي يفعله

- بحث شامل في الاسم والوصف والهاتف والمجال والمنطقة.
- اختيار عدة مجالات ومناطق.
- تبديل المطابقة بين "أي فلتر" و"كل الفلاتر".
- صفحة تفاصيل لكل ضيف مع أرقام الاتصال وروابط واتساب.
- تعديل الاسم والوصف/الوظيفة والهاتف والمجال والمنطقة.
- إضافة ضيف جديد أو متحدث جديد.
- إضافة حقول مخصصة تظهر في استمارة التعديل والتصدير.
- حفظ التعديلات والضيوف الجدد وحالة التواصل والملاحظات في Supabase عند التشغيل عبر Vercel أو الخادم المحلي مع متغيرات Supabase.
- تصدير النتائج المفلترة إلى CSV.

## ملاحظة خصوصية

التعديلات والضيوف الجدد والملاحظات وحالة التواصل تحفظ في Supabase عند ضبط متغيرات البيئة. عند فتح `index.html` مباشرة، تحفظ التعديلات في تخزين المتصفح المحلي على نفس الجهاز فقط.
