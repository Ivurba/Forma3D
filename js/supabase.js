import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = "https://yiogvivjcpfckkznrydm.supabase.co";
const supabasePublishableKey = "sb_publishable_alUGvfrJtcbOb5zjHk3c1w_Cu8u_NHi";

export const supabase = createClient(supabaseUrl, supabasePublishableKey);
