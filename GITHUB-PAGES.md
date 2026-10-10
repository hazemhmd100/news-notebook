# النشر على حساب hazemhmd100

المستودع: https://github.com/hazemhmd100/news-notebook

في Settings → Pages اختر Source: GitHub Actions. ملف `.github/workflows/pages.yml` يبني الواجهة ويختبرها ويرفع `dist` فقط.

العنوان المتوقع بعد نجاح النشر: https://hazemhmd100.github.io/news-notebook/

بدون إعداد Supabase تظهر رسالة «المفكرة قيد الإعداد» فقط. لا ترسل الرابط كبرنامج مكتمل حتى اختبار الدخول والجلب والحفظ.

اتبع README لإنشاء Supabase والوظيفة والجداول وحساب المالك. في المستودع، Settings → Secrets and variables → Actions → Variables، أضف القيم العامة VITE_SUPABASE_URL وVITE_SUPABASE_ANON_KEY وVITE_API_URL. لا تضع service_role هنا أو في ملفات المصدر.

في Supabase اجعل Site URL وRedirect URL يساويان https://hazemhmd100.github.io/news-notebook/، واجعل ALLOWED_ORIGINS يساوي https://hazemhmd100.github.io (دون مسار). أعد تشغيل Publish notebook من تبويب Actions بعد إضافة المتغيرات.

المشروع لمستخدم مالك واحد. لا يتيح إنشاء مفكرة مستقلة لكل زائر؛ عند تخصيصه للشخص الثاني اضبط OWNER_USER_ID لحسابه.

GitHub Pages لا يطبق ملف `_headers` الخاص بـCloudflare. حماية بيانات الأخبار تتم عبر خادم Supabase المقيد بالمالك والجداول المحجوبة عن المتصفح.
