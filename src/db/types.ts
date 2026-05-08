// Hand-written types derived from the Homebase Supabase schema.
// Run `supabase gen types typescript` to replace this with auto-generated types
// once the Supabase CLI is configured for the project.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string;
          name: string;
          industry: string | null;
          timezone: string;
          onboarding_complete: boolean;
          created_at: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          subscription_price: number | null;
          subscription_notes: string | null;
          billing_email: string | null;
        };
      };
      users: {
        Row: {
          id: string;
          company_id: string;
          email: string;
          name: string;
          role: 'quria' | 'owner' | 'manager';
          created_at: string;
          avatar_url: string | null;
        };
      };
      employees: {
        Row: {
          id: string;
          company_id: string;
          name: string;
          primary_role: string;
          qualified_roles: string[];
          max_weekly_hours: number;
          contact_phone: string | null;
          contact_email: string | null;
          active: boolean;
          created_at: string;
          individual_wage: number | null;
        };
      };
      availability: {
        Row: {
          id: string;
          employee_id: string;
          company_id: string;
          day_of_week: number;
          start_time: string;
          end_time: string;
        };
      };
      time_off_requests: {
        Row: {
          id: string;
          employee_id: string;
          company_id: string;
          start_date: string;
          end_date: string;
          reason: string | null;
          status: 'pending' | 'approved' | 'denied';
          requested_at: string;
          decided_at: string | null;
          decided_by: string | null;
        };
      };
      shift_types: {
        Row: {
          id: string;
          company_id: string;
          name: string;
          start_time: string;
          end_time: string;
          days_active: number[];
          active: boolean;
          created_at: string;
        };
      };
      shift_requirements: {
        Row: {
          id: string;
          company_id: string;
          shift_name: string;
          role: string;
          required_count: number;
          start_time: string;
          end_time: string;
          days_active: number[];
          shift_type_id: string | null;
        };
      };
      wage_rates: {
        Row: {
          id: string;
          company_id: string;
          role: string;
          hourly_rate: number;
        };
      };
      policies: {
        Row: {
          id: string;
          company_id: string;
          policy_key: string;
          policy_value: string;
          policy_type: 'time_off' | 'scheduling' | 'swaps' | 'coverage' | 'emergency' | 'general';
          description: string | null;
          version: number;
          created_at: string;
        };
      };
      schedules: {
        Row: {
          id: string;
          company_id: string;
          week_start: string;
          week_end: string;
          generated_at: string;
          generated_by: 'aegis' | 'manager';
          status: 'draft' | 'published';
          data: Json;
          staffing_report: Json | null;
          wages_file_url: string | null;
          approved_at: string | null;
          distributed_at: string | null;
        };
      };
      swap_requests: {
        Row: {
          id: string;
          company_id: string;
          requesting_employee_id: string;
          receiving_employee_id: string | null;
          shift_date: string;
          shift_name: string;
          role: string;
          status: 'pending_employee' | 'pending_manager' | 'approved' | 'denied' | 'cancelled';
          initiated_by: 'employee' | 'manager' | 'aegis';
          notes: string | null;
          decided_by: string | null;
          decided_at: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      events: {
        Row: {
          id: string;
          company_id: string;
          title: string;
          date: string | null;
          end_date: string | null;
          description: string | null;
          event_type: 'holiday' | 'special_event' | 'party' | 'fundraiser' | 'closure' | 'custom' | 'schedule' | 'time_off' | 'staffing' | 'manager_pref';
          staffing_notes: string | null;
          shift_overrides: Json | null;
          created_by: 'manager' | 'aegis' | 'soteria';
          created_at: string;
          updated_at: string;
        };
      };
      employee_conflicts: {
        Row: {
          id: string;
          company_id: string;
          employee_id_1: string;
          employee_id_2: string;
          reason: string | null;
          severity: 'avoid' | 'never';
          created_at: string;
        };
      };
      activity_log: {
        Row: {
          id: string;
          company_id: string;
          actor: 'aegis' | 'manager' | 'soteria' | 'system';
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          summary: string;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          company_id: string;
          actor: 'aegis' | 'manager' | 'soteria' | 'system';
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          summary: string;
          metadata?: Json | null;
        };
      };
      aegis_conversations: {
        Row: {
          id: string;
          company_id: string;
          channel: 'email' | 'sms';
          direction: 'inbound' | 'outbound';
          content: string;
          processed: boolean;
          thread_id: string | null;
          from_address: string | null;
          to_address: string | null;
          subject: string | null;
          created_at: string;
        };
        Insert: {
          company_id: string;
          channel: 'email' | 'sms';
          direction: 'inbound' | 'outbound';
          content: string;
          processed?: boolean;
          thread_id?: string | null;
          from_address?: string | null;
          to_address?: string | null;
          subject?: string | null;
        };
      };
      aegis_memory: {
        Row: {
          id: string;
          company_id: string;
          memory_type: 'pattern' | 'preference' | 'override' | 'observation';
          content: string;
          source: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      company_profiles: {
        Row: {
          id: string;
          company_id: string;
          business_type: string | null;
          description: string | null;
          operating_hours: string | null;
          peak_periods: string | null;
          manager_priorities: string | null;
          special_context: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      security_events: {
        Row: {
          id: string;
          event_type: 'unknown_sender' | 'company_match_no_employee' | 'unauthorized_action' | 'suspicious_pattern';
          channel: 'email' | 'sms';
          sender_contact: string;
          message_preview: string | null;
          resolution: string;
          company_id: string | null;
          created_at: string;
        };
        Insert: {
          event_type: 'unknown_sender' | 'company_match_no_employee' | 'unauthorized_action' | 'suspicious_pattern';
          channel: 'email' | 'sms';
          sender_contact: string;
          message_preview?: string | null;
          resolution?: string;
          company_id?: string | null;
        };
      };
      company_channels: {
        Row: {
          id: string;
          company_id: string;
          channel_type: 'sms' | 'email';
          channel_value: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          channel_type: 'sms' | 'email';
          channel_value: string;
        };
      };
      time_clock_integrations: {
        Row: {
          id: string;
          company_id: string;
          provider: string;
          api_key: string | null;
          api_base_url: string | null;
          location_id: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
      };
      payroll_integrations: {
        Row: {
          id: string;
          company_id: string;
          provider: string;
          api_key: string | null;
          company_identifier: string | null;
          pay_period: 'weekly' | 'biweekly' | 'semimonthly';
          payroll_check_day: number;
          auto_check_enabled: boolean;
          last_run_at: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
      };
    };
  };
}

// Convenience row types
export type Company = Database['public']['Tables']['companies']['Row'];
export type User = Database['public']['Tables']['users']['Row'];
export type Employee = Database['public']['Tables']['employees']['Row'];
export type Availability = Database['public']['Tables']['availability']['Row'];
export type TimeOffRequest = Database['public']['Tables']['time_off_requests']['Row'];
export type ShiftType = Database['public']['Tables']['shift_types']['Row'];
export type ShiftRequirement = Database['public']['Tables']['shift_requirements']['Row'];
export type WageRate = Database['public']['Tables']['wage_rates']['Row'];
export type Policy = Database['public']['Tables']['policies']['Row'];
export type Schedule = Database['public']['Tables']['schedules']['Row'];
export type SwapRequest = Database['public']['Tables']['swap_requests']['Row'];
export type Event = Database['public']['Tables']['events']['Row'];
export type EmployeeConflict = Database['public']['Tables']['employee_conflicts']['Row'];
export type ActivityLog = Database['public']['Tables']['activity_log']['Row'];
export type AegisConversation = Database['public']['Tables']['aegis_conversations']['Row'];
export type AegisMemory = Database['public']['Tables']['aegis_memory']['Row'];
export type CompanyProfile = Database['public']['Tables']['company_profiles']['Row'];
export type SecurityEvent = Database['public']['Tables']['security_events']['Row'];
export type CompanyChannel = Database['public']['Tables']['company_channels']['Row'];
